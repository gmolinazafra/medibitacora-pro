/**
 * MediBitácora Pro — Service Worker
 * ---------------------------------
 * Responsabilidades:
 *   1. Cachear la app para uso offline (cache-first con fallback a red).
 *   2. Programar notificaciones de medicación persistentes (showTrigger).
 *   3. Gestionar clicks/acciones en notificaciones (abrir app, marcar tomado).
 *
 * Importante: el nombre de la caché lleva versión; incrementarlo al publicar.
 */

const VERSION = 'v3.1.0';
const CACHE = `medibitacora-${VERSION}`;

// Rutas relativas: el SW está servido desde /bitacora/, así que './' = /bitacora/
// Los iconos están en /icons/ (raíz), referenciados con '../icons/...'
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './politica-privacidad.html',
  '../icons/icon-192.png',
  '../icons/icon-512.png'
];

// CDNs externos: los cacheamos pero con fallback a red si fallan.
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// ——————————————————————————————————————————————————————————
// INSTALACIÓN
// ——————————————————————————————————————————————————————————
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cachear assets locales (obligatorios). Si alguno falla, seguimos.
    await Promise.all(ASSETS.map(url =>
      cache.add(url).catch(err => console.warn('[SW] No se pudo cachear', url, err))
    ));
    // Cachear CDNs (opcional, no bloquea la instalación).
    await Promise.all(EXTERNAL_ASSETS.map(url =>
      fetch(url, { mode: 'cors' })
        .then(r => r.ok ? cache.put(url, r) : null)
        .catch(() => null)
    ));
    self.skipWaiting();
  })());
});

// ——————————————————————————————————————————————————————————
// ACTIVACIÓN — limpieza de cachés antiguos
// ——————————————————————————————————————————————————————————
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('medibitacora-') && k !== CACHE)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ——————————————————————————————————————————————————————————
// FETCH — cache-first con actualización en segundo plano
// ——————————————————————————————————————————————————————————
self.addEventListener('fetch', event => {
  const req = event.request;

  // Solo GET. Las peticiones POST/PUT se pasan directamente a la red.
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    // Cache-first
    if (cached) {
      // Revalidar en segundo plano sin bloquear la respuesta
      fetch(req).then(fresh => {
        if (fresh && fresh.ok && fresh.type !== 'opaque') {
          cache.put(req, fresh.clone()).catch(() => {});
        }
      }).catch(() => {});
      return cached;
    }

    // Si no está en caché, intentar red
    try {
      const fresh = await fetch(req);
      // Guardar solo respuestas válidas (no opacas, no errores)
      if (fresh && fresh.ok && fresh.type !== 'opaque') {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      // Sin red: devolver index como fallback para navegación
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html') || await cache.match('index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});

// ——————————————————————————————————————————————————————————
// MENSAJES DESDE LA APP
// ——————————————————————————————————————————————————————————
self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'PROGRAMAR_NOTIFICACIONES') {
    event.waitUntil(programarNotificaciones(data.meds || []));
    return;
  }

  if (data.type === 'CANCELAR_NOTIFICACIONES') {
    event.waitUntil(cancelarTodasLasNotificaciones());
    return;
  }

  if (data.type === 'PING') {
    // Útil para el cliente para saber si el SW está activo
    event.ports[0]?.postMessage({ type: 'PONG', version: VERSION });
  }
});

// ——————————————————————————————————————————————————————————
// PROGRAMACIÓN DE NOTIFICACIONES (showTrigger)
// ——————————————————————————————————————————————————————————
/**
 * Programa notificaciones futuras usando TimestampTrigger.
 * Solo funciona en Chromium con la PWA instalada.
 * Si no está soportado, el cliente se encargará de notificar cuando esté abierto.
 */
async function programarNotificaciones(meds) {
  // Cancelar cualquier programación previa
  await cancelarTodasLasNotificaciones();

  if (!('showTrigger' in Notification.prototype) && typeof TimestampTrigger === 'undefined') {
    // No hay soporte → el cliente se encargará con setInterval al abrirse
    return;
  }

  const ahora = new Date();
  const dias = ['D','L','M','X','J','V','S'];
  const programadas = [];

  for (const med of meds) {
    let f;
    try { f = JSON.parse(med.frecuencia || '{}'); } catch (e) { continue; }

    // Recolectar todas las horas del medicamento
    const tomas = []; // [{dia: 'L' o null, hora: 'HH:MM'}]
    if (f.tipo === 'diaria') {
      (f.horas || []).forEach(h => tomas.push({ dia: null, hora: h }));
    } else if (f.tipo === 'semanal') {
      if (f.hora) (f.dias || []).forEach(d => tomas.push({ dia: d, hora: f.hora }));
    }

    // Para cada toma, programar las próximas 7 ocurrencias (~ 1 semana)
    for (const t of tomas) {
      const horasIso = t.hora.split(':').map(Number);
      if (horasIso.length !== 2 || isNaN(horasIso[0])) continue;

      let ocurrencias = 0;
      for (let offset = 0; offset < 14 && ocurrencias < 7; offset++) {
        const fecha = new Date(ahora);
        fecha.setDate(fecha.getDate() + offset);
        fecha.setHours(horasIso[0], horasIso[1], 0, 0);
        if (fecha <= ahora) continue;
        if (t.dia && dias[fecha.getDay()] !== t.dia) continue;

        programadas.push({ med, fecha, hora: t.hora });
        ocurrencias++;
      }
    }
  }

  // Mostrar cada notificación programada con showTrigger
  for (const p of programadas) {
    try {
      await self.registration.showNotification('💊 Hora de tu medicación', {
        body: `${p.med.nombre}${p.med.dosis ? ' · ' + p.med.dosis : ''}`,
        icon: '../icons/icon-192.png',
        badge: '../icons/icon-192.png',
        tag: `med-${p.med.id || p.med.nombre}-${p.fecha.toISOString()}`,
        renotify: false,
        requireInteraction: true,
        silent: false,
        data: {
          medId: p.med.id || null,
          medNombre: p.med.nombre,
          medDosis: p.med.dosis || '',
          horaProgramada: p.hora,
          fechaProgramada: p.fecha.toISOString()
        },
        actions: [
          { action: 'tomado', title: '✓ Tomado' },
          { action: 'aplazar', title: '⏱ +10 min' }
        ],
        showTrigger: new TimestampTrigger(p.fecha.getTime())
      });
    } catch (err) {
      // Si falla showTrigger (no soportado o capacidad agotada), salimos silenciosamente
      console.warn('[SW] showTrigger no soportado o falló:', err.message);
      break;
    }
  }
}

async function cancelarTodasLasNotificaciones() {
  try {
    const notifs = await self.registration.getNotifications({ includeTriggered: false });
    for (const n of notifs) {
      // Solo cancelamos las de medicación (tag empieza por "med-")
      if (n.tag && n.tag.startsWith('med-')) n.close();
    }
  } catch (e) {}
}

// ——————————————————————————————————————————————————————————
// CLICK EN NOTIFICACIÓN
// ——————————————————————————————————————————————————————————
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action;

  if (action === 'aplazar') {
    // Re-programar 10 minutos después
    event.waitUntil((async () => {
      const cuando = Date.now() + 10 * 60 * 1000;
      try {
        await self.registration.showNotification('💊 Hora de tu medicación (aplazada)', {
          body: `${data.medNombre}${data.medDosis ? ' · ' + data.medDosis : ''}`,
          icon: '../icons/icon-192.png',
          badge: '../icons/icon-192.png',
          tag: `med-aplazada-${data.medId || data.medNombre}-${cuando}`,
          requireInteraction: true,
          data,
          actions: [
            { action: 'tomado', title: '✓ Tomado' },
            { action: 'aplazar', title: '⏱ +10 min' }
          ],
          showTrigger: typeof TimestampTrigger !== 'undefined' ? new TimestampTrigger(cuando) : undefined
        });
      } catch (e) {}
    })());
    return;
  }

  // Para "tomado" o click general: abrir la app
  // Si es "tomado", pasamos parámetros para que la app registre la toma
  const urlParams = action === 'tomado' && data.medId
    ? `?toma=${encodeURIComponent(data.medId)}&hora=${encodeURIComponent(data.horaProgramada || '')}`
    : '';

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si la app ya está abierta, enfocarla y avisar
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if (action === 'tomado' && data.medId) {
          client.postMessage({ type: 'MARCAR_TOMA', medId: data.medId, hora: data.horaProgramada });
        }
        return;
      }
    }
    // Si no, abrir nueva ventana
    if (self.clients.openWindow) {
      const baseUrl = self.registration.scope;
      await self.clients.openWindow(baseUrl + urlParams);
    }
  })());
});

// ——————————————————————————————————————————————————————————
// PERIODIC SYNC (fallback best-effort, requiere permiso especial)
// ——————————————————————————————————————————————————————————
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-meds') {
    // No hace nada por sí solo: las notificaciones futuras ya están programadas
    // con showTrigger. Este evento es una oportunidad para reprogramar en caso
    // de que la ventana de 7 días se haya agotado.
    // Por simplicidad, no hacemos nada aquí.
  }
});

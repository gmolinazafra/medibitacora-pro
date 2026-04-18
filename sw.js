const CACHE_NAME = 'medibitacora-v2';

// Recibe mensajes desde la app para programar notificaciones
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'PROGRAMAR_NOTIFICACIONES') {
    const meds = event.data.meds;
    programarNotificaciones(meds);
  }
});

function programarNotificaciones(meds) {
  // Limpia alarmas anteriores guardadas
  self.medicamentosAlarmas = meds;
}

// Comprueba cada minuto si hay que enviar notificación
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-meds') {
    event.waitUntil(checkMedsYNotificar());
  }
});

async function checkMedsYNotificar() {
  const meds = self.medicamentosAlarmas || [];
  const ahora = new Date();
  const horaActual = `${String(ahora.getHours()).padStart(2,'0')}:${String(ahora.getMinutes()).padStart(2,'0')}`;
  const diaActual = ['D','L','M','X','J','V','S'][ahora.getDay()];

  for (const med of meds) {
    let debeNotificar = false;
    try {
      const f = JSON.parse(med.frecuencia || '{}');
      if (f.tipo === 'diaria') {
        debeNotificar = (f.horas || []).includes(horaActual);
      } else if (f.tipo === 'semanal') {
        debeNotificar = (f.dias || []).includes(diaActual) && f.hora === horaActual;
      }
    } catch(e) {}

    if (debeNotificar) {
      await self.registration.showNotification('💊 MediBitácora Pro', {
        body: `Hora de tomar ${med.nombre}${med.dosis ? ' · ' + med.dosis : ''}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `med-${med.nombre}-${horaActual}`,
        renotify: false,
        requireInteraction: true,
        actions: [
          { action: 'tomado', title: '✓ Tomado' },
          { action: 'abrir', title: 'Abrir app' }
        ]
      });
    }
  }
}

// Click en la notificación
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'abrir' || !event.action) {
    event.waitUntil(clients.openWindow('/'));
  }
});
const CACHE_NAME_ASSETS = 'medibitacora-assets-v2';
const ASSETS = [
  '/medibitacora-pro/',
  '/medibitacora-pro/index.html',
  '/medibitacora-pro/manifest.json',
  '/medibitacora-pro/icon-192.png',
  '/medibitacora-pro/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME_ASSETS).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME_ASSETS).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('supabase.co') || event.request.url.includes('anthropic.com')) {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        return caches.open(CACHE_NAME_ASSETS).then(cache => {
          cache.put(event.request, response.clone());
          return response;
        });
      });
    }).catch(() => caches.match('/index.html'))
  );
});

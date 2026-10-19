const solicitudesPorIp = new Map();
const VENTANA_MS = 60 * 60 * 1000;
const MAX_SOLICITUDES = 30;

function limitar(ip) {
  const ahora = Date.now();
  const recientes = (solicitudesPorIp.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  recientes.push(ahora);
  solicitudesPorIp.set(ip, recientes);
  if (solicitudesPorIp.size > 5000) solicitudesPorIp.clear();
  return recientes.length > MAX_SOLICITUDES;
}

// Google Places API (New) solo devuelve hasta cinco reseñas por lugar. No se
// persiste ni se cachea contenido de Google; cada visita consulta la fuente viva.
export async function obtenerOpinionesGoogle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido.' });

  const host = String(req.headers.host || '').toLowerCase();
  const origen = String(req.headers.origin || req.headers.referer || '');
  if (!origen) return res.status(403).json({ error: 'Origen no permitido.' });
  try {
    const urlOrigen = new URL(origen);
    if (urlOrigen.protocol !== 'https:' || urlOrigen.host.toLowerCase() !== host) return res.status(403).json({ error: 'Origen no permitido.' });
  } catch {
    return res.status(403).json({ error: 'Origen no permitido.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  if (limitar(ip)) return res.status(429).json({ error: 'Demasiadas consultas. Probá más tarde.' });

  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'La sincronización de opiniones todavía no está configurada.' });

  try {
    const respuesta = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.reviews,places.googleMapsUri',
      },
      body: JSON.stringify({
        textQuery: 'Odontólogo Franco Vinzón, Ameghino 410, Concepción del Uruguay, Entre Ríos, Argentina',
        languageCode: 'es',
        regionCode: 'AR',
        pageSize: 1,
      }),
    });

    if (!respuesta.ok) {
      console.error('Google Places opiniones: respuesta', respuesta.status);
      return res.status(502).json({ error: 'No se pudieron actualizar las opiniones desde Google.' });
    }

    const lugar = (await respuesta.json())?.places?.[0];
    const nombre = String(lugar?.displayName?.text || '');
    const direccion = String(lugar?.formattedAddress || '');
    if (!/franco\s+vinz[oó]n/i.test(nombre) || !/ameghino\s+410/i.test(direccion)) {
      console.error('Google Places opiniones: el resultado no coincide con el consultorio');
      return res.status(502).json({ error: 'No se pudo confirmar el perfil del consultorio en Google.' });
    }

    const reviews = (Array.isArray(lugar.reviews) ? lugar.reviews : []).map((review) => {
      const autor = review.authorAttribution || {};
      return {
        rating: Number(review.rating) || 0,
        text: String(review.text?.text || review.originalText?.text || '').trim(),
        author: String(autor.displayName || ''),
        authorUri: String(autor.uri || ''),
        authorPhoto: String(autor.photoUri || ''),
        published: String(review.relativePublishTimeDescription || ''),
        originalText: String(review.originalText?.text || ''),
        translated: Boolean(review.text?.text && review.originalText?.text && review.text.text !== review.originalText.text),
        sourceUri: String(review.googleMapsUri || ''),
        flagContentUri: String(review.flagContentUri || ''),
      };
    }).filter((review) => review.rating >= 1 && review.rating <= 5 && review.text && review.author && review.sourceUri);

    return res.status(200).json({
      rating: Number(lugar.rating) || 0,
      reviewCount: Number(lugar.userRatingCount) || 0,
      reviews,
      googleMapsUri: String(lugar.googleMapsUri || 'https://maps.google.com/'),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Google Places opiniones: error de conexión', error?.name || 'Error');
    return res.status(502).json({ error: 'No se pudieron actualizar las opiniones desde Google.' });
  }
}

const puppeteer = require('puppeteer');

const SRT_URLS = {
  eServiciosHome: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
  expedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx',
  comunicacionesListado: 'https://eservicios.srt.gob.ar/MiVentanilla/ComunicacionesListado.aspx',
  apiExpedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx/ObtenerExpedientesMedicos'
};

const AFIP_SELECTORS = {
  inputCuit: '#F1\\:username',
  btnSiguiente: '#F1\\:btnSiguiente',
  inputPassword: '#F1\\:password',
  btnIngresar: '#F1\\:btnIngresar'
};

function parseDotNetDate(dotNetDate) {
  if (!dotNetDate) return null;
  const match = dotNetDate.match(/\/Date\((\d+)\)\//);
  return match ? new Date(parseInt(match[1])) : null;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loginYNavegarSRT(page, cuit, password) {
  console.log('🔐 Yendo directo a e-Servicios SRT...');
  
  await page.goto(SRT_URLS.eServiciosHome, { waitUntil: 'networkidle2', timeout: 60000 });
  
  if (page.url().includes('afip.gob.ar')) {
    console.log('📍 En AFIP, haciendo login...');
    
    await page.waitForSelector(AFIP_SELECTORS.inputCuit, { visible: true, timeout: 10000 });
    await page.type(AFIP_SELECTORS.inputCuit, cuit, { delay: 50 });
    await delay(500);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
      page.click(AFIP_SELECTORS.btnSiguiente)
    ]);
    
    await delay(1000);
    
    await page.waitForSelector(AFIP_SELECTORS.inputPassword, { visible: true, timeout: 10000 });
    await page.type(AFIP_SELECTORS.inputPassword, password, { delay: 50 });
    await delay(500);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click(AFIP_SELECTORS.btnIngresar)
    ]);
    
    await delay(3000);
  }
  
  console.log('📍 Después de login:', page.url());
  
  if (!page.url().includes('srt.gob.ar')) {
    return false;
  }
  
  console.log('✅ En e-Servicios SRT');
  return true;
}

async function navegarAExpedientes(page) {
  console.log('📍 Navegando a Expedientes...');
  await page.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  console.log('📍 URL actual:', page.url());
  return page.url().includes('Expedientes');
}

async function obtenerExpedientes(page) {
  console.log('📋 Obteniendo expedientes...');
  
  const response = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ numExpdte: null, numAnio: null })
      });
      return { status: res.status, data: await res.json() };
    } catch (e) {
      return { error: e.message };
    }
  }, SRT_URLS.apiExpedientes);
  
  if (response.error || !response.data?.d) {
    console.log('⚠️ Error:', response.error);
    return [];
  }
  
  console.log('✅ ' + response.data.d.length + ' expedientes');
  
  return response.data.d.map(exp => ({
    oid: exp.OID,
    nro: exp.Nro,
    motivo: exp.Motivo,
    damnificadoCuil: exp.Damnificado?.Cuil,
    damnificadoNombre: exp.Damnificado?.Nombre,
    fechaInicio: parseDotNetDate(exp.Inicio),
    comunicacionesSinLectura: exp.ComunicacionessinLectura || 0
  }));
}

async function obtenerComunicaciones(page, expedienteOid) {
  console.log('📨 Obteniendo comunicaciones para expediente OID:', expedienteOid);
  
  const url = `${SRT_URLS.comunicacionesListado}?idExpediente=${expedienteOid}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);
  
  console.log('📍 URL actual:', page.url());
  
  const comunicaciones = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('table tbody tr');
    
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;
      
      let traID = null;
      let catID = null;
      let tipoActor = null;
      
      const rowHtml = row.outerHTML;
      const match = rowHtml.match(/DetalleComunicacion\((\d+),(\d+),(\d+)\)/);
      if (match) {
        traID = match[1];
        catID = match[2];
        tipoActor = match[3];
      }
      
      results.push({
        fechaNotificacion: cells[0]?.innerText.trim(),
        expediente: cells[1]?.innerText.trim(),
        remitente: cells[2]?.innerText.trim(),
        sector: cells[3]?.innerText.trim(),
        tipoComunicacion: cells[4]?.innerText.trim(),
        estado: cells[5]?.innerText.trim(),
        fechaUltEstado: cells[6]?.innerText.trim(),
        traID,
        catID,
        tipoActor
      });
    }
    
    return results;
  });
  
  console.log('📨 Comunicaciones encontradas:', comunicaciones.length);
  if (comunicaciones.length > 0) {
    console.log('📨 Primera con traID:', comunicaciones[0].traID);
  }
  
  return comunicaciones;
}

async function obtenerDetalleComunicacion(page, traID, catID = '2', tipoActor = '1') {
  console.log('📄 Obteniendo detalle traID:', traID);
  
  // Hacer click en la lupa de esa comunicación
  const clicked = await page.evaluate((targetTraID) => {
    const images = document.querySelectorAll('img[onclick*="DetalleComunicacion"]');
    for (const img of images) {
      const onclick = img.getAttribute('onclick') || '';
      if (onclick.includes(targetTraID)) {
        img.click();
        return { clicked: true, onclick };
      }
    }
    return { clicked: false, total: images.length };
  }, traID);
  
  console.log('📄 Click en lupa:', JSON.stringify(clicked));
  
  if (!clicked.clicked) {
    console.log('⚠️ No se encontró la lupa para traID:', traID);
    return { error: 'Lupa no encontrada' };
  }
  
  // Esperar que aparezca el modal/iframe
  await delay(3000);
  
  // Buscar iframe o modal
  const frames = page.frames();
  console.log('📄 Frames encontrados:', frames.length);
  
  // Debug: ver qué hay en la página después del click
  const debug = await page.evaluate(() => {
    return {
      modals: document.querySelectorAll('.modal, [class*="modal"], [role="dialog"]').length,
      iframes: document.querySelectorAll('iframe').length,
      iframeSrcs: Array.from(document.querySelectorAll('iframe')).map(f => f.src),
      newDivs: document.querySelectorAll('div[style*="display: block"], div[style*="visibility: visible"]').length,
      bodyText: document.body.innerText.substring(0, 500)
    };
  });
  
  console.log('📄 Debug después de click:', JSON.stringify(debug));
  
  // Si hay iframes, buscar el que tiene el detalle
  let detalle = { tipoComunicacion: '', fecha: '', remitente: '', detalle: '', archivosAdjuntos: [] };
  
  if (debug.iframes > 0) {
    for (const frame of frames) {
      const frameUrl = frame.url();
      console.log('📄 Frame URL:', frameUrl);
      
      if (frameUrl.includes('DetalleComunicacion') || frameUrl.includes('Detalle')) {
        console.log('📄 Encontré frame de detalle!');
        
        detalle = await frame.evaluate(() => {
          const result = {
            tipoComunicacion: '',
            fecha: '',
            remitente: '',
            detalle: '',
            archivosAdjuntos: [],
            bodyText: document.body.innerText.substring(0, 1000)
          };
          
          const body = document.body.innerText;
          
          const tipoMatch = body.match(/Tipo de Comunicación:\s*([^\n]+)/);
          if (tipoMatch) result.tipoComunicacion = tipoMatch[1].trim();
          
          const fechaMatch = body.match(/Fecha:\s*([^\n]+)/);
          if (fechaMatch) result.fecha = fechaMatch[1].trim();
          
          const remitenteMatch = body.match(/Remitente:\s*([^\n]+)/);
          if (remitenteMatch) result.remitente = remitenteMatch[1].trim();
          
          const detalleMatch = body.match(/Detalle:\s*([^\n]+)/);
          if (detalleMatch) result.detalle = detalleMatch[1].trim();
          
          const downloadLinks = document.querySelectorAll('a[href*="Download"]');
          for (const link of downloadLinks) {
            const href = link.getAttribute('href');
            result.archivosAdjuntos.push({
              href: href,
              text: link.innerText.trim()
            });
          }
          
          return result;
        });
        
        break;
      }
    }
  }
  
  console.log('📄 Detalle encontrado:', detalle.tipoComunicacion);
  console.log('📄 Adjuntos:', detalle.archivosAdjuntos?.length || 0);
  
  return detalle;
}

async function descargarPdf(page, archivoAdjunto) {
  console.log('⬇️ Descargando:', archivoAdjunto.nombre || archivoAdjunto.href);
  
  const pdfData = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      
      const blob = await res.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ 
          base64: reader.result.split(',')[1],
          size: blob.size,
          type: blob.type
        });
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return { error: e.message };
    }
  }, archivoAdjunto.href);
  
  return pdfData;
}

module.exports = {
  loginYNavegarSRT,
  navegarAExpedientes,
  obtenerExpedientes,
  obtenerComunicaciones,
  obtenerDetalleComunicacion,
  descargarPdf,
  parseDotNetDate,
  SRT_URLS,
  delay
};

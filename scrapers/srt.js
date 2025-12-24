const puppeteer = require('puppeteer');

const SRT_URLS = {
  eServiciosHome: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
  expedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx',
  comunicaciones: 'https://eservicios.srt.gob.ar/MiVentanilla/ComunicacionesFiltroV2.aspx',
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
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1000);
  
  const clickedVerOpciones = await page.evaluate(() => {
    const cards = document.querySelectorAll('h5, h4, h3, .card-title, div');
    for (const card of cards) {
      if (card.innerText && card.innerText.includes('Patrocinio Letrado')) {
        const parent = card.closest('.card, .panel, section, div[class*="card"], div[class*="panel"]') || card.parentElement.parentElement;
        if (parent) {
          const btn = parent.querySelector('button, a');
          if (btn) { btn.click(); return true; }
        }
      }
    }
    return false;
  });
  
  await delay(2000);
  
  await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.innerText.includes('Expedientes') || link.href.includes('Expedientes')) {
        link.click();
        return true;
      }
    }
    return false;
  });
  
  await delay(2000);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  
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
  
  // Navegar a la página de comunicaciones del expediente
  const url = `${SRT_URLS.comunicaciones}?return=expedientesPatrocinantes&idExpediente=${expedienteOid}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  console.log('📍 URL comunicaciones:', page.url());
  
  // Scrapear la tabla de comunicaciones
  const comunicaciones = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr, .grid-row, [class*="row"]');
    const results = [];
    
    // Buscar todos los links que vayan a DetalleComunicacion
    const links = document.querySelectorAll('a[href*="DetalleComunicacion"]');
    
    for (const link of links) {
      const href = link.getAttribute('href');
      const urlParams = new URLSearchParams(href.split('?')[1]);
      const traID = urlParams.get('traID');
      
      // Buscar la fila padre para obtener más datos
      const row = link.closest('tr') || link.closest('[class*="row"]') || link.parentElement;
      const cells = row ? row.querySelectorAll('td, [class*="col"]') : [];
      
      const textos = Array.from(cells).map(c => c.innerText.trim());
      
      results.push({
        traID,
        href,
        textos,
        linkText: link.innerText.trim()
      });
    }
    
    // También buscar en el HTML general por patrones
    const html = document.body.innerHTML;
    const traIDMatches = html.match(/traID=(\d+)/g) || [];
    
    return {
      comunicaciones: results,
      traIDsEncontrados: [...new Set(traIDMatches)],
      htmlPreview: document.body.innerText.substring(0, 2000)
    };
  });
  
  console.log('📨 Comunicaciones encontradas:', comunicaciones.comunicaciones.length);
  console.log('📨 traIDs en HTML:', comunicaciones.traIDsEncontrados.length);
  
  return comunicaciones;
}

async function obtenerDetalleComunicacion(page, traID) {
  console.log('📄 Obteniendo detalle de comunicación traID:', traID);
  
  const url = `https://eservicios.srt.gob.ar/MiVentanilla/DetalleComunicacion.aspx?traID=${traID}&catID=2&traIDTIPOACTOR=1`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  // Scrapear el detalle
  const detalle = await page.evaluate(() => {
    const result = {
      tipoComunicacion: '',
      fecha: '',
      remitente: '',
      detalle: '',
      archivosAdjuntos: [],
      movimientos: []
    };
    
    // Buscar campos del detalle
    const body = document.body.innerText;
    
    // Tipo de Comunicación
    const tipoMatch = body.match(/Tipo de Comunicación:\s*([^\n]+)/);
    if (tipoMatch) result.tipoComunicacion = tipoMatch[1].trim();
    
    // Fecha
    const fechaMatch = body.match(/Fecha:\s*([^\n]+)/);
    if (fechaMatch) result.fecha = fechaMatch[1].trim();
    
    // Remitente
    const remitenteMatch = body.match(/Remitente:\s*([^\n]+)/);
    if (remitenteMatch) result.remitente = remitenteMatch[1].trim();
    
    // Detalle
    const detalleMatch = body.match(/Detalle:\s*([^\n]+)/);
    if (detalleMatch) result.detalle = detalleMatch[1].trim();
    
    // Buscar archivos adjuntos (links de descarga)
    const downloadLinks = document.querySelectorAll('a[href*="Download.aspx"]');
    for (const link of downloadLinks) {
      const href = link.getAttribute('href');
      const urlParams = new URLSearchParams(href.split('?')[1]);
      result.archivosAdjuntos.push({
        id: urlParams.get('id'),
        idTipoRef: urlParams.get('idTipoRef'),
        nombre: urlParams.get('nombre') || link.innerText.trim(),
        href: href.startsWith('http') ? href : 'https://eservicios.srt.gob.ar' + href
      });
    }
    
    return result;
  });
  
  console.log('📄 Archivos adjuntos:', detalle.archivosAdjuntos.length);
  
  return detalle;
}

async function descargarPdf(page, archivoAdjunto) {
  console.log('⬇️ Descargando PDF:', archivoAdjunto.nombre);
  
  // Descargar el PDF como base64
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

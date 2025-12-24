const puppeteer = require('puppeteer');

const SRT_URLS = {
  eServiciosHome: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
  expedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx',
  comunicacionesListado: 'https://eservicios.srt.gob.ar/MiVentanilla/ComunicacionesListado.aspx',
  apiExpedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx/ObtenerExpedientesMedicos',
  detalleComunicacion: 'https://eservicios.srt.gob.ar/MiVentanilla/DetalleComunicacion.aspx'
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
  
  // Hacer fetch del HTML del detalle (con doble t en ttraIDTIPOACTOR como en el HAR)
  const detalleUrl = `${SRT_URLS.detalleComunicacion}?traID=${traID}&catID=${catID}&ttraIDTIPOACTOR=${tipoActor}`;
  console.log('📄 Fetch URL:', detalleUrl);
  
  const detalle = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      
      const html = await res.text();
      
      // Parsear el HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      const result = {
        tipoComunicacion: '',
        fecha: '',
        remitente: '',
        detalle: '',
        archivosAdjuntos: [],
        htmlPreview: html.substring(0, 500)
      };
      
      const body = doc.body?.innerText || html;
      
      const tipoMatch = body.match(/Tipo de Comunicación:\s*([^\n]+)/);
      if (tipoMatch) result.tipoComunicacion = tipoMatch[1].trim();
      
      const fechaMatch = body.match(/Fecha:\s*([^\n]+)/);
      if (fechaMatch) result.fecha = fechaMatch[1].trim();
      
      const remitenteMatch = body.match(/Remitente:\s*([^\n]+)/);
      if (remitenteMatch) result.remitente = remitenteMatch[1].trim();
      
      const detalleMatch = body.match(/Detalle:\s*([^\n]+)/);
      if (detalleMatch) result.detalle = detalleMatch[1].trim();
      
      // Buscar links de descarga
      const downloadLinks = doc.querySelectorAll('a[href*="Download"]');
      for (const link of downloadLinks) {
        const href = link.getAttribute('href');
        const fullHref = href.startsWith('http') ? href : 'https://eservicios.srt.gob.ar/MiVentanilla/' + href;
        
        // Parsear parámetros
        const urlParams = new URLSearchParams(fullHref.split('?')[1] || '');
        
        result.archivosAdjuntos.push({
          id: urlParams.get('id'),
          idTipoRef: urlParams.get('idTipoRef'),
          nombre: urlParams.get('nombre') || link.innerText.trim(),
          href: fullHref
        });
      }
      
      return result;
    } catch (e) {
      return { error: e.message };
    }
  }, detalleUrl);
  
  console.log('📄 Tipo:', detalle.tipoComunicacion);
  console.log('📄 Adjuntos:', detalle.archivosAdjuntos?.length || 0);
  if (detalle.archivosAdjuntos?.length > 0) {
    console.log('📄 Primer adjunto:', JSON.stringify(detalle.archivosAdjuntos[0]));
  }
  
  return detalle;
}

async function descargarPdf(page, archivoAdjunto) {
  const url = archivoAdjunto.href;
  console.log('⬇️ Descargando:', archivoAdjunto.nombre, 'desde', url);
  
  const pdfData = await page.evaluate(async (downloadUrl) => {
    try {
      const res = await fetch(downloadUrl, { credentials: 'include' });
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
  }, url);
  
  console.log('⬇️ Resultado:', pdfData.error || `${pdfData.size} bytes, tipo: ${pdfData.type}`);
  
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

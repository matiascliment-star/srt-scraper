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
  
  await page.evaluate(() => {
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
  
  const url = `${SRT_URLS.comunicaciones}?return=expedientesPatrocinantes&idExpediente=${expedienteOid}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  console.log('📍 URL comunicaciones:', page.url());
  
  // Esperar el botón
  await page.waitForSelector('#btnBuscar', { visible: true, timeout: 5000 });
  console.log('🔍 Botón #btnBuscar encontrado');
  
  // Click con Puppeteer y esperar navegación a ComunicacionesListado.aspx
  console.log('🔍 Clickeando #btnBuscar...');
  
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    page.click('#btnBuscar')
  ]);
  
  console.log('📍 Nueva URL:', page.url());
  
  await delay(3000);
  
  // Debug
  const debug = await page.evaluate(() => {
    return {
      url: window.location.href,
      tables: document.querySelectorAll('table').length,
      tbodyRows: document.querySelectorAll('table tbody tr').length,
      allTr: document.querySelectorAll('tr').length,
      pageText: document.body.innerText.substring(0, 1000)
    };
  });
  
  console.log('📍 Debug - tables:', debug.tables, 'tbody tr:', debug.tbodyRows, 'all tr:', debug.allTr);
  console.log('📍 Texto:', debug.pageText.substring(0, 500));
  
  // Scrapear
  const comunicaciones = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('table tbody tr, table tr');
    
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;
      
      let traID = null;
      const rowHtml = row.outerHTML;
      const match = rowHtml.match(/traID=(\d+)/i);
      if (match) traID = match[1];
      
      results.push({
        fechaNotificacion: cells[0]?.innerText.trim(),
        expediente: cells[1]?.innerText.trim(),
        remitente: cells[2]?.innerText.trim(),
        sector: cells[3]?.innerText.trim(),
        tipoComunicacion: cells[4]?.innerText.trim(),
        estado: cells[5]?.innerText.trim(),
        fechaUltEstado: cells[6]?.innerText.trim(),
        traID
      });
    }
    
    return results;
  });
  
  console.log('📨 Comunicaciones encontradas:', comunicaciones.length);
  if (comunicaciones.length > 0) {
    console.log('📨 Primera:', JSON.stringify(comunicaciones[0]));
  }
  
  return comunicaciones;
}

async function obtenerDetalleComunicacion(page, traID) {
  console.log('📄 Obteniendo detalle de comunicación traID:', traID);
  
  const url = `https://eservicios.srt.gob.ar/MiVentanilla/DetalleComunicacion.aspx?traID=${traID}&catID=2&traIDTIPOACTOR=1`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);
  
  const detalle = await page.evaluate(() => {
    const result = {
      tipoComunicacion: '',
      fecha: '',
      remitente: '',
      detalle: '',
      archivosAdjuntos: []
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
    
    const downloadLinks = document.querySelectorAll('a[href*="Download.aspx"]');
    for (const link of downloadLinks) {
      const href = link.getAttribute('href');
      const fullHref = href.startsWith('http') ? href : 'https://eservicios.srt.gob.ar' + (href.startsWith('/') ? '' : '/MiVentanilla/') + href;
      const urlParams = new URLSearchParams(fullHref.split('?')[1] || '');
      result.archivosAdjuntos.push({
        id: urlParams.get('id'),
        idTipoRef: urlParams.get('idTipoRef'),
        nombre: urlParams.get('nombre') || link.innerText.trim(),
        href: fullHref
      });
    }
    
    return result;
  });
  
  console.log('📄 Detalle:', detalle.tipoComunicacion, '- Adjuntos:', detalle.archivosAdjuntos.length);
  
  return detalle;
}

async function descargarPdf(page, archivoAdjunto) {
  console.log('⬇️ Descargando PDF:', archivoAdjunto.nombre);
  
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

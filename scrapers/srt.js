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
  
  // Esperar más tiempo para que cargue el contenido dinámico
  await delay(5000);
  
  // Esperar a que aparezca alguna tabla o grid
  await page.waitForSelector('table, .grid, [class*="grid"], [class*="list"]', { timeout: 10000 }).catch(() => {
    console.log('⚠️ No se encontró tabla/grid');
  });
  
  console.log('📍 URL comunicaciones:', page.url());
  
  // Debug: ver qué hay en la página
  const debug = await page.evaluate(() => {
    return {
      title: document.title,
      bodyLength: document.body.innerHTML.length,
      tables: document.querySelectorAll('table').length,
      grids: document.querySelectorAll('[class*="grid"]').length,
      rows: document.querySelectorAll('tr').length,
      links: document.querySelectorAll('a').length,
      // Ver texto visible
      visibleText: document.body.innerText.substring(0, 1500)
    };
  });
  
  console.log('📍 Debug página:', JSON.stringify({
    tables: debug.tables,
    grids: debug.grids, 
    rows: debug.rows,
    links: debug.links
  }));
  console.log('📍 Texto visible:', debug.visibleText.substring(0, 500));
  
  // Scrapear comunicaciones
  const comunicaciones = await page.evaluate(() => {
    const results = [];
    
    // Buscar links a DetalleComunicacion
    const links = document.querySelectorAll('a[href*="DetalleComunicacion"], a[href*="detalle"], a[onclick*="Detalle"]');
    console.log('Links DetalleComunicacion:', links.length);
    
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const onclick = link.getAttribute('onclick') || '';
      
      let traID = null;
      const traIDMatch = (href + onclick).match(/traID=(\d+)/);
      if (traIDMatch) traID = traIDMatch[1];
      
      results.push({
        traID,
        href,
        onclick,
        text: link.innerText.trim()
      });
    }
    
    // Buscar también en filas de tabla
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      const onclick = row.getAttribute('onclick') || '';
      const traIDMatch = onclick.match(/traID=(\d+)/);
      if (traIDMatch) {
        results.push({
          traID: traIDMatch[1],
          source: 'row-onclick',
          text: row.innerText.substring(0, 100)
        });
      }
    }
    
    // Buscar traIDs en cualquier parte del HTML
    const html = document.body.innerHTML;
    const allTraIDs = [...new Set((html.match(/traID[=:](\d+)/gi) || []).map(m => m.match(/\d+/)[0]))];
    
    return {
      comunicaciones: results,
      allTraIDs
    };
  });
  
  console.log('📨 Comunicaciones encontradas:', comunicaciones.comunicaciones.length);
  console.log('📨 traIDs en HTML:', comunicaciones.allTraIDs);
  
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
      const fullHref = href.startsWith('http') ? href : 'https://eservicios.srt.gob.ar' + (href.startsWith('/') ? '' : '/') + href;
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

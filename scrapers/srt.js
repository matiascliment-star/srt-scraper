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
  
  // Ir a la página de comunicaciones filtrada por expediente
  const url = `${SRT_URLS.comunicaciones}?return=expedientesPatrocinantes&idExpediente=${expedienteOid}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  console.log('📍 URL comunicaciones:', page.url());
  
  // Clickear el botón BUSCAR
  console.log('🔍 Clickeando BUSCAR...');
  const clicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"], a.btn');
    for (const btn of buttons) {
      if (btn.innerText.includes('BUSCAR') || btn.value === 'BUSCAR') {
        btn.click();
        return true;
      }
    }
    // Buscar por ID común
    const buscarBtn = document.querySelector('#btnBuscar, [id*="Buscar"], [name*="Buscar"]');
    if (buscarBtn) {
      buscarBtn.click();
      return true;
    }
    return false;
  });
  
  console.log('📍 Click BUSCAR:', clicked);
  
  // Esperar que cargue la tabla
  await delay(5000);
  
  // Esperar a que aparezca la tabla con resultados
  await page.waitForSelector('table tbody tr, .grid-row', { timeout: 10000 }).catch(() => {
    console.log('⚠️ No se encontró tabla con resultados');
  });
  
  // Scrapear las comunicaciones de la tabla
  const comunicaciones = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('table tbody tr');
    
    console.log('Filas encontradas:', rows.length);
    
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;
      
      // Buscar el link de detalle (la lupa)
      const detalleLink = row.querySelector('a[href*="DetalleComunicacion"], a[onclick*="Detalle"], a img[src*="lupa"], a i, a svg');
      let traID = null;
      let detalleHref = null;
      
      // Buscar en el link o en el onclick de la fila
      const linkElement = row.querySelector('a[href*="traID"]') || row.querySelector('a');
      if (linkElement) {
        detalleHref = linkElement.getAttribute('href') || '';
        const onclick = linkElement.getAttribute('onclick') || row.getAttribute('onclick') || '';
        const match = (detalleHref + onclick).match(/traID=(\d+)/);
        if (match) traID = match[1];
      }
      
      // También buscar en todo el HTML de la fila
      if (!traID) {
        const rowHtml = row.innerHTML;
        const match = rowHtml.match(/traID=(\d+)/);
        if (match) traID = match[1];
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
        detalleHref
      });
    }
    
    return results;
  });
  
  console.log('📨 Comunicaciones encontradas:', comunicaciones.length);
  if (comunicaciones.length > 0) {
    console.log('📨 Primera comunicación:', JSON.stringify(comunicaciones[0]));
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
    
    // Buscar archivos adjuntos
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

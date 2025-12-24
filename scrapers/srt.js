const puppeteer = require('puppeteer');

const SRT_URLS = {
  eServiciosHome: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
  expedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx',
  comunicacionesFiltro: 'https://eservicios.srt.gob.ar/MiVentanilla/ComunicacionesFiltroV2.aspx',
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

async function obtenerComunicacionesYDetalle(page, expedienteOid) {
  console.log('📨 Obteniendo comunicaciones para expediente OID:', expedienteOid);
  
  // Ir al frameset principal
  const url = `${SRT_URLS.comunicacionesFiltro}?return=expedientesPatrocinantes&idExpediente=${expedienteOid}`;
  console.log('📍 Yendo a:', url);
  
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  // Ver los frames
  const allFrames = page.frames();
  console.log('📍 Frames totales:', allFrames.length);
  
  for (const frame of allFrames) {
    console.log('📍 Frame:', frame.url());
  }
  
  // Click en BUSCAR si existe
  try {
    await page.click('#btnBuscar');
    console.log('📍 Click en BUSCAR');
    await delay(5000);
  } catch (e) {
    console.log('📍 No se encontró btnBuscar, continuando...');
  }
  
  // Ver frames después del click
  const framesAfter = page.frames();
  console.log('📍 Frames después de buscar:', framesAfter.length);
  for (const frame of framesAfter) {
    console.log('📍 Frame:', frame.url());
  }
  
  // Buscar el frame con la lista
  let listaFrame = null;
  for (const frame of framesAfter) {
    if (frame.url().includes('ComunicacionesListado')) {
      listaFrame = frame;
      break;
    }
  }
  
  if (!listaFrame) {
    console.log('⚠️ No se encontró frame de lista');
    // Intentar scrapear del frame principal
    listaFrame = page.mainFrame();
  }
  
  // Scrapear comunicaciones del frame
  const comunicaciones = await listaFrame.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('table tbody tr, table tr');
    
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
  
  return comunicaciones;
}

async function obtenerDetalleComunicacion(page, traID, catID = '2', tipoActor = '1') {
  console.log('📄 Obteniendo detalle traID:', traID);
  
  // Buscar el frame con la lista y hacer click en la lupa
  const allFrames = page.frames();
  let listaFrame = null;
  
  for (const frame of allFrames) {
    if (frame.url().includes('ComunicacionesListado') || frame.url().includes('Comunicacion')) {
      listaFrame = frame;
      break;
    }
  }
  
  if (!listaFrame) {
    listaFrame = page.mainFrame();
  }
  
  // Click en la lupa
  const clicked = await listaFrame.evaluate((targetTraID) => {
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
  
  await delay(3000);
  
  // Buscar el frame de detalle que se abrió
  const framesAfterClick = page.frames();
  console.log('📄 Frames después de click:', framesAfterClick.length);
  
  let detalleFrame = null;
  for (const frame of framesAfterClick) {
    const frameUrl = frame.url();
    console.log('📄 Checking frame:', frameUrl);
    if (frameUrl.includes('DetalleComunicacion')) {
      detalleFrame = frame;
      console.log('📄 Encontré frame de detalle!');
      break;
    }
  }
  
  if (!detalleFrame) {
    console.log('⚠️ No se encontró frame de detalle');
    return { error: 'No se encontró frame de detalle' };
  }
  
  // Scrapear el detalle del frame
  const detalle = await detalleFrame.evaluate(() => {
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
  
  console.log('📄 Detalle:', detalle.tipoComunicacion);
  console.log('📄 Body preview:', detalle.bodyText?.substring(0, 300));
  console.log('📄 Adjuntos:', detalle.archivosAdjuntos.length);
  
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

// Función legacy para compatibilidad
async function obtenerComunicaciones(page, expedienteOid) {
  return obtenerComunicacionesYDetalle(page, expedienteOid);
}

module.exports = {
  loginYNavegarSRT,
  navegarAExpedientes,
  obtenerExpedientes,
  obtenerComunicaciones,
  obtenerComunicacionesYDetalle,
  obtenerDetalleComunicacion,
  descargarPdf,
  parseDotNetDate,
  SRT_URLS,
  delay
};

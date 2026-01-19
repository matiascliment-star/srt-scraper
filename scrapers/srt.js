// puppeteer-core se usa desde server.js

const SRT_URLS = {
  eServiciosHome: 'https://eservicios.srt.gob.ar/home/Servicios.aspx',
  expedientes: 'https://eservicios.srt.gob.ar/Patrocinio/Expedientes/Expedientes.aspx',
  comunicacionesFiltro: 'https://eservicios.srt.gob.ar/MiVentanilla/ComunicacionesFiltroV2.aspx',
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
  if (!page.url().includes('srt.gob.ar')) return false;
  console.log('✅ En e-Servicios SRT');
  return true;
}

async function navegarAExpedientes(page) {
  await page.goto(SRT_URLS.expedientes, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1000);
  return true;
}

async function obtenerExpedientes(page) {
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
  
  if (response.error || !response.data?.d) return [];
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
  // Ir al frameset con el filtro - esto establece el contexto correcto
  const filtroUrl = `${SRT_URLS.comunicacionesFiltro}?return=expedientesPatrocinantes&idExpediente=${expedienteOid}`;
  await page.goto(filtroUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  
  // Esperar a que cargue el frame con los resultados
  const frames = page.frames();
  let listaFrame = null;
  
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes('ComunicacionesListado')) {
      listaFrame = frame;
      break;
    }
  }
  
  // Si no hay frame, buscar en la página principal
  const targetFrame = listaFrame || page.mainFrame();
  
  const resultado = await targetFrame.evaluate(() => {
    const comunicaciones = [];
    const rows = document.querySelectorAll('table tbody tr');
    
    for (const row of rows) {
      const rowHtml = row.outerHTML;
      const match = rowHtml.match(/DetalleComunicacion\((\d+),(\d+),(\d+)\)/);
      if (!match) continue;
      
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;
      
      comunicaciones.push({
        fechaNotificacion: cells[0]?.innerText.trim(),
        expediente: cells[1]?.innerText.trim(),
        remitente: cells[2]?.innerText.trim(),
        sector: cells[3]?.innerText.trim(),
        tipoComunicacion: cells[4]?.innerText.trim(),
        estado: cells[5]?.innerText.trim(),
        fechaUltEstado: cells[6]?.innerText.trim(),
        traID: match[1],
        catID: match[2],
        tipoActor: match[3]
      });
    }
    
    // Buscar total del expediente específico
    const totalText = document.body.innerText;
    const totalMatch = totalText.match(/Total Consulta:\s*(\d+)/);
    const totalReal = totalMatch ? parseInt(totalMatch[1]) : comunicaciones.length;
    
    return { comunicaciones, totalReal };
  });
  
  console.log(`📨 ${resultado.comunicaciones.length}/${resultado.totalReal}`);
  return resultado.comunicaciones;
}

async function obtenerDetalleComunicacion(page, traID, catID = '2', tipoActor = '1') {
  const detalleUrl = `${SRT_URLS.detalleComunicacion}?traID=${traID}&catID=${catID}&ttraIDTIPOACTOR=${tipoActor}`;
  
  return await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include' });
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      const result = { tipoComunicacion: '', fecha: '', detalle: '', archivosAdjuntos: [] };
      const body = doc.body?.innerText || '';
      
      const tipoMatch = body.match(/Tipo de Comunicación:\s*([^\n]+)/);
      if (tipoMatch) result.tipoComunicacion = tipoMatch[1].trim();
      
      const detalleMatch = body.match(/Detalle:\s*([^\n]+)/);
      if (detalleMatch) result.detalle = detalleMatch[1].trim();
      
      const downloadLinks = doc.querySelectorAll('a[href*="Download"]');
      for (const link of downloadLinks) {
        const href = link.getAttribute('href');
        let fullHref = href.startsWith('http') ? href : 
                       href.startsWith('/') ? 'https://eservicios.srt.gob.ar' + href :
                       'https://eservicios.srt.gob.ar/MiVentanilla/' + href;
        
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
      return { error: e.message, archivosAdjuntos: [] };
    }
  }, detalleUrl);
}

async function descargarPdf(page, archivoAdjunto) {
  const detalleUrl = `${SRT_URLS.detalleComunicacion}?traID=0&catID=2&ttraIDTIPOACTOR=1`;
  await page.goto(detalleUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  
  return await page.evaluate(async (downloadUrl) => {
    try {
      const res = await fetch(downloadUrl, { credentials: 'include' });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      
      const arrayBuffer = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
      
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      
      return { base64: btoa(binary), size: bytes.length, isPdf };
    } catch (e) {
      return { error: e.message };
    }
  }, archivoAdjunto.href);
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

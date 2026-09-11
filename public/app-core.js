/* ============================================================
   FESTIVAL DE LA UVA — CONTROL DE VENTAS
   ============================================================ */

const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtCOP = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Math.round(n || 0));
const fmtNum = n => new Intl.NumberFormat('es-CO').format(Math.round(n || 0));
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });

function requestConfirmation(message, title = 'Confirmar eliminación') {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-backdrop" data-confirm-cancel></div>
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <div class="confirm-icon">!</div>
        <h2 id="confirmTitle">${title}</h2>
        <p>${message}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" data-confirm-cancel>Cancelar</button>
          <button class="btn btn-danger" data-confirm-ok>Eliminar definitivamente</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    const close = result => { modal.remove(); resolve(result); };
    modal.querySelectorAll('[data-confirm-cancel]').forEach(button => button.onclick = () => close(false));
    modal.querySelector('[data-confirm-ok]').onclick = () => close(true);
  });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Supabase ---------- */
const SUPABASE_URL = 'https://bxhycxrnnrlwnschtran.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4aHljeHJubnJsd25zY2h0cmFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNjk3NTQsImV4cCI6MjEwNDY0NTc1NH0.k_O1c3lD9Dl0OL5FCkK5eNxKIjBGSXOBx_3u9vD7HDk';

// Algunos entornos de vista previa interceptan window.fetch y reenvían la petición
// mediante postMessage; ese mecanismo no puede clonar un objeto Headers (DataCloneError).
// Este wrapper convierte los headers a un objeto plano antes de llamar a fetch, que sí es clonable.
function sandboxSafeFetch(input, init = {}) {
  const safeInit = { ...init };
  if (safeInit.headers && typeof Headers !== 'undefined' && safeInit.headers instanceof Headers) {
    const plain = {};
    safeInit.headers.forEach((value, key) => { plain[key] = value; });
    safeInit.headers = plain;
  }
  return window.fetch(input, safeInit);
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: sandboxSafeFetch }
});

/* ---------- productos ---------- */
async function getProducts(vendedorId) {
  const { data, error } = await sb.from('productos').select('*').eq('vendedor_id', vendedorId).eq('activo', true).order('created_at', { ascending: true });
  if (error) { console.error('getProducts', error); return []; }
  return (data || []).map(p => ({ id: p.id, nombre: p.nombre, precioVenta: Number(p.precio_venta), ganancia: Number(p.ganancia) }));
}
async function addProduct(vendedorId, nombre, precioVenta, ganancia) {
  const { error } = await sb.from('productos').insert({ vendedor_id: vendedorId, nombre, precio_venta: precioVenta, ganancia, activo: true });
  return error;
}
async function deleteProduct(productId) {
  const { error } = await sb.rpc('fn_eliminar_producto', { p_producto_id: productId });
  return error;
}

/* ---------- ventas + venta_items ---------- */
async function getVentas(vendedorId) {
  const { data: ventasRows, error } = await sb.from('ventas').select('*').eq('vendedor_id', vendedorId).order('fecha', { ascending: true });
  if (error) { console.error('getVentas', error); return {}; }
  const ids = (ventasRows || []).map(v => v.id);
  let itemsRows = [];
  if (ids.length > 0) {
    const { data: items, error: err2 } = await sb.from('venta_items').select('*').in('venta_id', ids);
    if (err2) console.error('getVentaItems', err2); else itemsRows = items || [];
  }
  const out = {};
  (ventasRows || []).forEach(v => {
    out[v.fecha] = {
      items: itemsRows.filter(i => i.venta_id === v.id).map(i => ({
        productId: i.producto_id, nombre: i.nombre_producto, unidades: i.unidades,
        precioVenta: Number(i.precio_venta), ganancia: Number(i.ganancia)
      })),
      efectivo: Number(v.efectivo),
      transferencia: Number(v.transferencia),
      ingresoTotal: Number(v.ingreso_total),
      gananciaTotal: Number(v.ganancia_total),
      totalUnidades: v.total_unidades,
      registradoEn: v.registrado_en,
    };
  });
  return out;
}

// Guarda cabecera (ventas) + detalle (venta_items) de forma atómica vía la función SQL fn_guardar_registro_diario
async function guardarRegistroDiario(vendedorId, fecha, items, efectivo, transferencia) {
  const { data, error } = await sb.rpc('fn_guardar_registro_diario', {
    p_vendedor_id: vendedorId,
    p_fecha: fecha,
    p_items: items.map(it => ({
      producto_id: it.productId, nombre: it.nombre,
      unidades: it.unidades, precio_venta: it.precioVenta, ganancia: it.ganancia
    })),
    p_efectivo: efectivo,
    p_transferencia: transferencia,
  });
  return { data, error };
}

async function eliminarHistorial(vendedorId) {
  const { error } = await sb.rpc('fn_eliminar_historial_vendedor', { p_vendedor_id: vendedorId });
  return error;
}

/* ---------- usuarios ---------- */
async function ensureAdmin() {
  const { data, error } = await sb.from('usuarios').select('*').eq('username', 'admin').maybeSingle();
  if (error) {
    console.error('ensureAdmin', error.message, error.details, error.hint, error.code);
    state.initError = `${error.message || 'Error desconocido'}${error.hint ? ' — ' + error.hint : ''}`;
    return;
  }
  if (!data) console.info('No existe el usuario admin. Créalo desde supabase-rls-fix.sql.');
}

/* ---------- app state ---------- */
const state = {
  session: JSON.parse(localStorage.getItem('festivalUvaSession') || 'null'),
  authTab: 'login',
  authError: '',
  vendedorTab: 'productos',
  adminTab: 'vendedores',
  adminSelected: null,
  regDate: todayStr(),
  loading: true,
  initError: null,
};
const charts = {}; // canvasId -> Chart instance

const app = document.getElementById('app');

function grapesLogo(size = 30) {
  return `<img class="grapes-logo" src="imagen/logo.jpg" width="${size}" height="${size}" alt="Feria de la Uva Villa del Rosario 2026">`;
}

/* ============================================================
   RENDER ROOT
   ============================================================ */
function render() {
  if (state.loading) {
    app.innerHTML = `<div class="auth-shell"><div class="loading">${grapesLogo(40)}<br><br>Cargando la plataforma…</div></div>`;
    return;
  }
  if (APP_PAGE === 'auth') {
    if (state.session) { window.location.replace(state.session.role === 'admin' ? 'admin.html' : 'vendedor.html'); return; }
    renderAuth();
    return;
  }
  if (!state.session) { window.location.replace('index.html'); return; }
  if (APP_PAGE === 'admin' && state.session.role !== 'admin') { window.location.replace('vendedor.html'); return; }
  if (APP_PAGE === 'vendedor' && state.session.role === 'admin') { window.location.replace('admin.html'); return; }
  if (APP_PAGE === 'admin') { renderAdmin(); } else { renderVendedor(); }
}

/* ============================================================
   AUTH VIEW
   ============================================================ */
function renderAuth() {
  const t = state.authTab;
  app.innerHTML = `
  <div class="auth-shell">
    <div class="auth-card">
      <div class="brand">
        ${grapesLogo(38)}
        <div>
          <span>Festival de la Uva</span>
          <h1>Control de Ventas</h1>
        </div>
      </div>
      <div class="tabs">
        <button class="tab-btn ${t === 'login' ? 'active' : ''}" id="tabLogin">Ingresar</button>
        <button class="tab-btn ${t === 'register' ? 'active' : ''}" id="tabRegister">Crear cuenta de vendedor</button>
      </div>
      ${t === 'login' ? `
        <label class="first">Usuario</label>
        <input type="text" id="loginUser" placeholder="tu usuario" autocomplete="username">
        <label>Contraseña</label>
        <input type="password" id="loginPass" placeholder="tu contraseña" autocomplete="current-password">
        <button class="btn btn-primary" id="btnLogin">Ingresar</button>
      ` : `
        <label class="first">Nombre del vendedor o del puesto</label>
        <input type="text" id="regNombre" placeholder="Ej: Dulces de la Abuela">
        <label>Usuario</label>
        <input type="text" id="regUser" placeholder="crea un usuario" autocomplete="username">
        <label>Contraseña</label>
        <input type="password" id="regPass" placeholder="crea una contraseña" autocomplete="new-password">
        <label>Confirmar contraseña</label>
        <input type="password" id="regPass2" placeholder="repite la contraseña" autocomplete="new-password">
        <button class="btn btn-primary" id="btnRegister">Crear cuenta</button>
      `}
      ${state.authError ? `<div class="msg msg-error">${state.authError}</div>` : ''}
      ${state.initError ? `<div class="msg msg-error">No se pudo conectar con la base de datos: ${state.initError}</div>` : ''}
    </div>
  </div>`;

  document.getElementById('tabLogin').onclick = () => { state.authTab = 'login'; state.authError = ''; render(); };
  document.getElementById('tabRegister').onclick = () => { state.authTab = 'register'; state.authError = ''; render(); };

  if (t === 'login') {
    document.getElementById('btnLogin').onclick = doLogin;
    document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  } else {
    document.getElementById('btnRegister').onclick = doRegister;
  }
}

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  if (!username || !password) { state.authError = 'Ingresa tu usuario y tu contraseña.'; render(); return; }
  const { data: u, error } = await sb.from('usuarios').select('*').eq('username', username).maybeSingle();
  if (error) { state.authError = 'No se pudo conectar con la base de datos. Intenta de nuevo.'; render(); return; }
  if (!u) { state.authError = 'No existe ese usuario. Verifica o crea una cuenta nueva.'; render(); return; }
  const hash = await sha256Hex(password);
  if (hash !== u.password_hash) { state.authError = 'La contraseña no es correcta.'; render(); return; }
  state.session = { id: u.id, username: u.username, role: u.rol, nombre: u.nombre };
  localStorage.setItem('festivalUvaSession', JSON.stringify(state.session));
  state.authError = '';
  window.location.replace(state.session.role === 'admin' ? 'admin.html' : 'vendedor.html');
}

async function doRegister() {
  const nombre = document.getElementById('regNombre').value.trim();
  const username = document.getElementById('regUser').value.trim();
  const pass = document.getElementById('regPass').value;
  const pass2 = document.getElementById('regPass2').value;
  if (!nombre || !username || !pass) { state.authError = 'Completa todos los campos.'; render(); return; }
  if (username.toLowerCase() === 'admin') { state.authError = 'Ese usuario está reservado.'; render(); return; }
  if (pass.length < 4) { state.authError = 'La contraseña debe tener al menos 4 caracteres.'; render(); return; }
  if (pass !== pass2) { state.authError = 'Las contraseñas no coinciden.'; render(); return; }
  const { data: inserted, error } = await sb.from('usuarios')
    .insert({ username, password_hash: await sha256Hex(pass), nombre, rol: 'vendedor' })
    .select()
    .single();
  if (error) {
    state.authError = (error.code === '23505') ? 'Ese usuario ya existe, elige otro.' : ('No se pudo crear la cuenta: ' + error.message);
    render(); return;
  }
  state.session = { id: inserted.id, username: inserted.username, role: 'vendedor', nombre: inserted.nombre };
  localStorage.setItem('festivalUvaSession', JSON.stringify(state.session));
  state.authError = '';
  window.location.replace('vendedor.html');
}

function logout() {
  state.session = null;
  state.vendedorTab = 'productos'; state.adminTab = 'vendedores'; state.adminSelected = null;
  localStorage.removeItem('festivalUvaSession');
  window.location.replace('index.html');
}

/* ============================================================
   TOPBAR (shared)
   ============================================================ */
function topbarHtml() {
  return `
  <div class="topbar">
    <div class="brand">${grapesLogo(28)}<div><h1>Festival de la Uva</h1><div class="who">${state.session.nombre}</div></div></div>
    <div class="topbar-right">
      <span class="pill">${state.session.role === 'admin' ? 'Organización' : 'Vendedor'}</span>
      <button class="btn btn-ghost btn-sm" id="btnLogout" style="background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.25);">Salir</button>
    </div>
  </div>`;
}

/* ============================================================
   VENDEDOR APP
   ============================================================ */
async function renderVendedor() {
  const vendedorId = state.session.id;
  const products = await getProducts(vendedorId);
  const ventas = await getVentas(vendedorId);
  const tabs = [
    ['productos', 'Mis productos'],
    ['registro', 'Registro del día'],
    ['historial', 'Historial'],
  ];
  app.innerHTML = `
    <div class="app-shell">
      ${topbarHtml()}
      <div class="nav">${tabs.map(([k, l]) => `<button class="nav-btn ${state.vendedorTab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="content" id="vContent"></div>
    </div>`;
  document.getElementById('btnLogout').onclick = logout;
  document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => { state.vendedorTab = b.dataset.tab; render(); });

  const c = document.getElementById('vContent');
  if (state.vendedorTab === 'productos') c.innerHTML = vendedorProductosHtml(products);
  if (state.vendedorTab === 'registro') c.innerHTML = vendedorRegistroHtml(products, ventas);
  if (state.vendedorTab === 'historial') c.innerHTML = vendedorHistorialHtml(ventas);
  if (state.vendedorTab === 'resumen') c.innerHTML = vendedorResumenHtml(ventas);

  if (state.vendedorTab === 'productos') bindProductos(vendedorId, products);
  if (state.vendedorTab === 'registro' && products.length > 0) bindRegistro(vendedorId, products, ventas);
  if (state.vendedorTab === 'historial') bindHistorial(vendedorId, Object.keys(ventas).length > 0);
  if (state.vendedorTab === 'resumen') drawResumenChart(ventas);
}

function vendedorProductosHtml(products) {
  return `
  <div class="section-title"><h2>Mis productos</h2></div>
  <div class="section-sub">Agrega cada producto que vas a vender, con su valor comercial (precio de venta) y la ganancia que te deja cada unidad.</div>
  <div class="card">
    <h3>Agregar producto</h3>
    <div class="grid3">
      <div><label class="first">Nombre del producto *</label><input type="text" id="pNombre" placeholder="Ej: Copa de vino" required></div>
      <div><label class="first">Valor comercial (precio de venta) *</label><input type="number" id="pPrecio" min="0.01" step="1" placeholder="Ej: 10000" required></div>
      <div><label class="first">Ganancia por unidad *</label><input type="number" id="pGanancia" min="0.01" step="1" placeholder="Ej: 4000" required></div>
    </div>
    <div class="hint">* Los tres campos son obligatorios. La ganancia debe ser mayor a $0.</div>
    <button class="btn btn-gold" id="btnAddProduct" style="margin-top:16px;">Agregar producto</button>
    <div id="pMsg"></div>
  </div>
  <div class="card">
    <h3>Productos registrados (${products.length})</h3>
    ${products.length === 0 ? `<div class="empty">Aún no has agregado productos.</div>` : `
      <div class="product-row" style="border-bottom:2px solid var(--cream-2);"><b style="font-size:11.5px;text-transform:uppercase;color:var(--ink-soft);">Producto</b><b style="font-size:11.5px;text-transform:uppercase;color:var(--ink-soft);">Precio</b><b style="font-size:11.5px;text-transform:uppercase;color:var(--ink-soft);">Ganancia/u</b><b></b></div>
      ${products.map(p => `
        <div class="product-row">
          <div>${p.nombre}</div>
          <div>${fmtCOP(p.precioVenta)}</div>
          <div style="color:var(--leaf);font-weight:700;">${fmtCOP(p.ganancia)}</div>
          <button class="btn btn-danger btn-sm" data-del="${p.id}">Eliminar</button>
        </div>`).join('')}
    `}
  </div>`;
}

function bindProductos(vendedorId, products) {
  document.getElementById('btnAddProduct').onclick = async () => {
    const nombre = document.getElementById('pNombre').value.trim();
    const precioRaw = document.getElementById('pPrecio').value;
    const gananciaRaw = document.getElementById('pGanancia').value;
    const precioVenta = parseFloat(precioRaw);
    const ganancia = parseFloat(gananciaRaw);
    const msg = document.getElementById('pMsg');
    if (!nombre) {
      msg.innerHTML = `<div class="msg msg-error">El nombre del producto es obligatorio.</div>`; return;
    }
    if (precioRaw === '' || isNaN(precioVenta) || precioVenta <= 0) {
      msg.innerHTML = `<div class="msg msg-error">El valor comercial es obligatorio y debe ser mayor a $0.</div>`; return;
    }
    if (gananciaRaw === '' || isNaN(ganancia) || ganancia <= 0) {
      msg.innerHTML = `<div class="msg msg-error">La ganancia por unidad es obligatoria y debe ser mayor a $0.</div>`; return;
    }
    if (ganancia > precioVenta) {
      msg.innerHTML = `<div class="msg msg-error">La ganancia no puede ser mayor al valor comercial.</div>`; return;
    }
    const error = await addProduct(vendedorId, nombre, precioVenta, ganancia);
    if (error) {
      msg.innerHTML = `<div class="msg msg-error">No se pudo guardar el producto: ${error.message}</div>`; return;
    }
    render();
  };
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const accepted = await requestConfirmation(
        'Se eliminará el producto y todas sus ventas relacionadas. Esta acción también actualizará el historial y no se puede deshacer.',
        '¿Eliminar producto?'
      );
      if (!accepted) return;
      const error = await deleteProduct(btn.dataset.del);
      if (error) { alert('No se pudo eliminar el producto: ' + error.message); return; }
      render();
    };
  });
}

function vendedorRegistroHtml(products, ventas) {
  const date = state.regDate;
  const existing = ventas[date];
  if (products.length === 0) {
    return `<div class="section-title"><h2>Registro del día</h2></div>
      <div class="card"><div class="empty">Primero agrega tus productos en la pestaña "Mis productos".</div></div>`;
  }
  return `
  <div class="section-title"><h2>Registro del día</h2></div>
  <div class="section-sub">Al finalizar el día, cuenta cuántas unidades vendiste de cada producto y cuánto recibiste en efectivo y por transferencia.</div>
  <div class="card">
    <label class="first">Fecha del festival</label>
    <input type="date" id="regDateInput" value="${date}" style="max-width:220px;">
    ${existing ? `<div class="warn">Ya existe un registro para este día. Si guardas, se actualizará con los nuevos valores.</div>` : ''}
    <div class="divider"></div>
    <h3>Unidades vendidas</h3>
    <div class="unit-row" style="border-bottom:2px solid var(--cream-2);">
      <b style="font-size:11.5px;text-transform:uppercase;color:var(--ink-soft);">Producto</b>
      <b style="font-size:11.5px;text-transform:uppercase;color:var(--ink-soft);">Unidades</b>
      <b style="font-size:11.5px;text-transform:uppercase;color:var(--ink-soft);">Ingreso</b>
      <b style="font-size:11.5px;text-transform:uppercase;color:var(--ink-soft);">Ganancia</b>
    </div>
    ${products.map(p => {
    const prev = existing?.items?.find(i => i.productId === p.id);
    const u = prev ? prev.unidades : 0;
    return `<div class="unit-row" data-prow="${p.id}">
        <div><div class="pname">${p.nombre}</div><div class="sub">${fmtCOP(p.precioVenta)} c/u · ganancia ${fmtCOP(p.ganancia)}</div></div>
        <input type="number" min="0" class="unit-input" data-pid="${p.id}" data-precio="${p.precioVenta}" data-ganancia="${p.ganancia}" value="${u}">
        <div class="line-ingreso" data-line-ing="${p.id}">${fmtCOP(u * p.precioVenta)}</div>
        <div class="line-ganancia" data-line-gan="${p.id}" style="color:var(--leaf);font-weight:700;">${fmtCOP(u * p.ganancia)}</div>
      </div>`;
  }).join('')}
    <div class="divider"></div>
    <div class="grid2">
      <div><label class="first">Recibido en efectivo *</label><input type="number" min="0" id="regEfectivo" placeholder="Obligatorio, escribe 0 si no hubo" value="${existing?.efectivo ?? ''}" required></div>
      <div><label class="first">Recibido por transferencia *</label><input type="number" min="0" id="regTransfer" placeholder="Obligatorio, escribe 0 si no hubo" value="${existing?.transferencia ?? ''}" required></div>
    </div>
    <div class="hint">* Debes escribir un valor en los dos campos (puede ser 0) antes de poder guardar.</div>
    <div class="ticket" style="margin-top:20px;">
      <div class="row"><div><div class="lbl">Total ingreso a caja</div><div class="amt" id="totIngreso">${fmtCOP(existing?.ingresoTotal || 0)}</div></div>
      <div><div class="lbl">Total ganancia</div><div class="amt" id="totGanancia">${fmtCOP(existing?.gananciaTotal || 0)}</div></div></div>
    </div>
    <div id="regDiff"></div>
    <button class="btn btn-gold" id="btnSaveReg" style="margin-top:8px;">Guardar registro del día</button>
    <div id="regMsg"></div>
  </div>`;
}

function bindRegistro(vendedorId, products, ventas) {
  document.getElementById('regDateInput').onchange = (e) => { state.regDate = e.target.value; render(); };

  function recompute() {
    let ing = 0, gan = 0, ef = 0, tr = 0;
    document.querySelectorAll('.unit-input').forEach(inp => {
      const u = parseFloat(inp.value) || 0;
      const precio = parseFloat(inp.dataset.precio);
      const ganancia = parseFloat(inp.dataset.ganancia);
      const pid = inp.dataset.pid;
      document.querySelector(`[data-line-ing="${pid}"]`).textContent = fmtCOP(u * precio);
      document.querySelector(`[data-line-gan="${pid}"]`).textContent = fmtCOP(u * ganancia);
      ing += u * precio; gan += u * ganancia;
    });
    ef = parseFloat(document.getElementById('regEfectivo').value) || 0;
    tr = parseFloat(document.getElementById('regTransfer').value) || 0;
    document.getElementById('totIngreso').textContent = fmtCOP(ing);
    document.getElementById('totGanancia').textContent = fmtCOP(gan);
    const diff = ing - (ef + tr);
    const diffEl = document.getElementById('regDiff');
    if (Math.abs(diff) > 0.5) {
      diffEl.innerHTML = `<div class="warn">El efectivo + transferencia (${fmtCOP(ef + tr)}) no coincide con el ingreso calculado (${fmtCOP(ing)}). No podrás guardar hasta que ambos valores sean iguales. Diferencia: ${fmtCOP(diff)}.</div>`;
    } else {
      diffEl.innerHTML = '';
    }
  }
  document.querySelectorAll('.unit-input').forEach(inp => inp.addEventListener('input', recompute));
  document.getElementById('regEfectivo').addEventListener('input', recompute);
  document.getElementById('regTransfer').addEventListener('input', recompute);

  document.getElementById('btnSaveReg').onclick = async () => {
    const regMsg = document.getElementById('regMsg');
    const efectivoRaw = document.getElementById('regEfectivo').value;
    const transferRaw = document.getElementById('regTransfer').value;

    const faltantes = [];
    if (efectivoRaw === '') faltantes.push('Recibido en efectivo');
    if (transferRaw === '') faltantes.push('Recibido por transferencia');
    if (faltantes.length > 0) {
      regMsg.innerHTML = `<div class="msg msg-error">No se pudo guardar. Falta completar: <b>${faltantes.join(', ')}</b>. Escribe un valor (puede ser 0) en cada campo.</div>`;
      return;
    }

    const efectivo = parseFloat(efectivoRaw);
    const transferencia = parseFloat(transferRaw);
    if (isNaN(efectivo) || efectivo < 0 || isNaN(transferencia) || transferencia < 0) {
      regMsg.innerHTML = `<div class="msg msg-error">El efectivo y la transferencia deben ser números válidos, iguales o mayores a 0.</div>`;
      return;
    }

    const items = [];
    let ingresoTotal = 0, gananciaTotal = 0, totalUnidades = 0;
    document.querySelectorAll('.unit-input').forEach(inp => {
      const u = parseFloat(inp.value) || 0;
      const p = products.find(x => x.id === inp.dataset.pid);
      if (u > 0) {
        items.push({ productId: p.id, nombre: p.nombre, unidades: u, precioVenta: p.precioVenta, ganancia: p.ganancia });
        ingresoTotal += u * p.precioVenta; gananciaTotal += u * p.ganancia; totalUnidades += u;
      }
    });

    const diff = Math.round((ingresoTotal - (efectivo + transferencia)) * 100) / 100;
    if (Math.abs(diff) > 0.5) {
      const quePaso = diff > 0
        ? `falta registrar ${fmtCOP(diff)} en efectivo y/o transferencia`
        : `hay ${fmtCOP(Math.abs(diff))} de más en efectivo + transferencia frente a lo vendido`;
      regMsg.innerHTML = `<div class="msg msg-error">No se pudo guardar: el efectivo (${fmtCOP(efectivo)}) más la transferencia (${fmtCOP(transferencia)}) = ${fmtCOP(efectivo + transferencia)}, pero el ingreso calculado según las unidades vendidas es ${fmtCOP(ingresoTotal)}. Es decir, ${quePaso}. Revisa las unidades vendidas o los valores de efectivo/transferencia para que coincidan exactamente.</div>`;
      return;
    }

    const { error: rpcError } = await guardarRegistroDiario(vendedorId, state.regDate, items, efectivo, transferencia);
    if (rpcError) {
      regMsg.innerHTML = `<div class="msg msg-error">No se pudo guardar: ${rpcError.message}</div>`;
      return;
    }
    ventas[state.regDate] = { items, efectivo, transferencia, ingresoTotal, gananciaTotal, totalUnidades, registradoEn: Date.now() };
    regMsg.innerHTML = '<div class="msg msg-ok">Registro exitoso, revisa el Historial.</div>';
  };
}

function vendedorHistorialHtml(ventas) {
  const dates = Object.keys(ventas).sort().reverse();
  if (dates.length === 0) return `<div class="section-title"><h2>Historial</h2></div><div class="card"><div class="empty">Todavía no has guardado ningún registro diario.</div></div>`;
  let tI = 0, tG = 0, tE = 0, tT = 0, tU = 0;
  const rows = dates.map(d => {
    const v = ventas[d]; tI += v.ingresoTotal; tG += v.gananciaTotal; tE += v.efectivo; tT += v.transferencia; tU += v.totalUnidades;
    return `<tr><td>${fmtDate(d)}</td><td>${fmtNum(v.totalUnidades)}</td><td>${fmtCOP(v.ingresoTotal)}</td><td style="color:var(--leaf);font-weight:700;">${fmtCOP(v.gananciaTotal)}</td><td>${fmtCOP(v.efectivo)}</td><td>${fmtCOP(v.transferencia)}</td></tr>`;
  }).join('');
  return `
  <div class="section-title"><h2>Historial de ventas</h2><button class="btn btn-danger btn-sm" id="btnClearHistory">Borrar historial</button></div>
  <div class="card table-wrap">
    <table>
      <thead><tr><th>Día</th><th>Unidades</th><th>Ingreso</th><th>Ganancia</th><th>Efectivo</th><th>Transferencia</th></tr></thead>
      <tbody>${rows}<tr class="totals"><td>Total</td><td>${fmtNum(tU)}</td><td>${fmtCOP(tI)}</td><td>${fmtCOP(tG)}</td><td>${fmtCOP(tE)}</td><td>${fmtCOP(tT)}</td></tr></tbody>
    </table>
  </div>`;
}

function bindHistorial(vendedorId, hasHistory) {
  const button = document.getElementById('btnClearHistory');
  if (!button || !hasHistory) return;
  button.onclick = async () => {
    const accepted = await requestConfirmation(
      'Se borrarán todos tus registros diarios y sus detalles. Esta acción no se puede deshacer.',
      '¿Borrar historial?'
    );
    if (!accepted) return;
    button.disabled = true;
    const error = await eliminarHistorial(vendedorId);
    if (error) {
      button.disabled = false;
      alert('No se pudo borrar el historial: ' + error.message);
      return;
    }
    render();
  };
}

function vendedorResumenHtml(ventas) {
  const dates = Object.keys(ventas);
  if (dates.length === 0) return `<div class="section-title"><h2>Resumen</h2></div><div class="card"><div class="empty">Aún no hay datos para mostrar un resumen.</div></div>`;
  let tI = 0, tG = 0, tE = 0, tT = 0, tU = 0;
  const productMix = {};
  dates.forEach(d => {
    const v = ventas[d]; tI += v.ingresoTotal; tG += v.gananciaTotal; tE += v.efectivo; tT += v.transferencia; tU += v.totalUnidades;
    v.items.forEach(it => { productMix[it.nombre] = (productMix[it.nombre] || 0) + it.unidades; });
  });
  return `
  <div class="section-title"><h2>Resumen general</h2></div>
  <div class="stat-row">
    <div class="stat-card"><div class="lbl">Días registrados</div><div class="val">${dates.length}</div></div>
    <div class="stat-card gold"><div class="lbl">Ingreso total</div><div class="val">${fmtCOP(tI)}</div></div>
    <div class="stat-card leaf"><div class="lbl">Ganancia total</div><div class="val">${fmtCOP(tG)}</div></div>
    <div class="stat-card"><div class="lbl">Unidades vendidas</div><div class="val">${fmtNum(tU)}</div></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>Efectivo vs. transferencia</h3><div class="chart-box"><canvas id="chartPago"></canvas></div></div>
    <div class="card"><h3>Mezcla de productos vendidos</h3><div class="chart-box"><canvas id="chartMix"></canvas></div></div>
  </div>`;
}

function drawResumenChart(ventas) {
  const dates = Object.keys(ventas);
  if (dates.length === 0) return;
  let tE = 0, tT = 0; const productMix = {};
  dates.forEach(d => { const v = ventas[d]; tE += v.efectivo; tT += v.transferencia; v.items.forEach(it => { productMix[it.nombre] = (productMix[it.nombre] || 0) + it.unidades; }); });
  makeChart('chartPago', 'doughnut', { labels: ['Efectivo', 'Transferencia'], datasets: [{ data: [tE, tT], backgroundColor: ['#C9973B', '#6B2357'] }] });
  const mixEntries = Object.entries(productMix).sort((a, b) => b[1] - a[1]).slice(0, 8);
  makeChart('chartMix', 'bar', { labels: mixEntries.map(e => e[0]), datasets: [{ label: 'Unidades', data: mixEntries.map(e => e[1]), backgroundColor: '#8C3B58' }] }, { indexAxis: 'y' });
}

/* ============================================================
   ADMIN APP
   ============================================================ */
async function getAllVendedoresData() {
  const { data: vendedoresRows, error } = await sb.from('usuarios').select('*').eq('rol', 'vendedor').order('nombre', { ascending: true });
  if (error) { console.error('getAllVendedoresData', error); return []; }
  const data = [];
  for (const v of (vendedoresRows || [])) {
    const products = await getProducts(v.id);
    const ventas = await getVentas(v.id);
    let ingreso = 0, ganancia = 0, unidades = 0, efectivo = 0, transferencia = 0, dias = 0;
    Object.values(ventas).forEach(day => { ingreso += day.ingresoTotal; ganancia += day.gananciaTotal; unidades += day.totalUnidades; efectivo += day.efectivo; transferencia += day.transferencia; dias++; });
    data.push({ id: v.id, username: v.username, nombre: v.nombre, products, ventas, ingreso, ganancia, unidades, efectivo, transferencia, dias });
  }
  return data;
}

async function renderAdmin() {
  const tabs = [['vendedores', 'Vendedores'], ['rankings', 'Rankings'], ['graficas', 'Gráficas'], ['detalle', 'Detalle por vendedor']];
  app.innerHTML = `
    <div class="app-shell">
      ${topbarHtml()}
      <div class="nav">${tabs.map(([k, l]) => `<button class="nav-btn ${state.adminTab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
        <button class="nav-btn" id="btnRefresh" style="margin-left:auto;color:var(--wine);">↻ Actualizar datos</button>
      </div>
      <div class="content" id="aContent"><div class="loading">Cargando información de los vendedores…</div></div>
    </div>`;
  document.getElementById('btnLogout').onclick = logout;
  document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.onclick = () => { state.adminTab = b.dataset.tab; render(); });
  document.getElementById('btnRefresh').onclick = render;

  const data = await getAllVendedoresData();
  const c = document.getElementById('aContent');
  if (data.length === 0) { c.innerHTML = `<div class="section-title"><h2>Sin vendedores todavía</h2></div><div class="card"><div class="empty">Cuando los vendedores creen su cuenta y registren ventas, la información aparecerá aquí.</div></div>`; return; }

  if (state.adminTab === 'vendedores') c.innerHTML = adminVendedoresHtml(data);
  if (state.adminTab === 'rankings') c.innerHTML = adminRankingsHtml(data);
  if (state.adminTab === 'graficas') c.innerHTML = adminGraficasHtml(data);
  if (state.adminTab === 'detalle') c.innerHTML = adminDetalleHtml(data);

  if (state.adminTab === 'graficas') drawAdminCharts(data);
  if (state.adminTab === 'detalle') bindDetalle(data);
}

function adminVendedoresHtml(data) {
  const totals = data.reduce((a, d) => ({ ingreso: a.ingreso + d.ingreso, ganancia: a.ganancia + d.ganancia, unidades: a.unidades + d.unidades, efectivo: a.efectivo + d.efectivo, transferencia: a.transferencia + d.transferencia }), { ingreso: 0, ganancia: 0, unidades: 0, efectivo: 0, transferencia: 0 });
  const sorted = [...data].sort((a, b) => b.ingreso - a.ingreso);
  return `
  <div class="section-title"><h2>Vendedores del festival</h2></div>
  <div class="section-sub">${data.length} vendedores registrados.</div>
  <div class="stat-row">
    <div class="stat-card gold"><div class="lbl">Ingreso total del festival</div><div class="val">${fmtCOP(totals.ingreso)}</div></div>
    <div class="stat-card leaf"><div class="lbl">Ganancia total</div><div class="val">${fmtCOP(totals.ganancia)}</div></div>
    <div class="stat-card"><div class="lbl">Unidades vendidas</div><div class="val">${fmtNum(totals.unidades)}</div></div>
    <div class="stat-card"><div class="lbl">Efectivo / Transferencia</div><div class="val" style="font-size:16px;">${fmtCOP(totals.efectivo)} · ${fmtCOP(totals.transferencia)}</div></div>
  </div>
  <div class="card table-wrap">
    <table>
      <thead><tr><th>Vendedor</th><th>Productos</th><th>Días activos</th><th>Unidades</th><th>Ingreso</th><th>Ganancia</th><th>Efectivo</th><th>Transferencia</th></tr></thead>
      <tbody>
        ${sorted.map(d => `<tr><td><b>${d.nombre}</b></td><td>${d.products.length}</td><td>${d.dias}</td><td>${fmtNum(d.unidades)}</td><td>${fmtCOP(d.ingreso)}</td><td style="color:var(--leaf);font-weight:700;">${fmtCOP(d.ganancia)}</td><td>${fmtCOP(d.efectivo)}</td><td>${fmtCOP(d.transferencia)}</td></tr>`).join('')}
        <tr class="totals"><td>Total</td><td></td><td></td><td>${fmtNum(totals.unidades)}</td><td>${fmtCOP(totals.ingreso)}</td><td>${fmtCOP(totals.ganancia)}</td><td>${fmtCOP(totals.efectivo)}</td><td>${fmtCOP(totals.transferencia)}</td></tr>
      </tbody>
    </table>
  </div>`;
}

function rankListHtml(items, valueFmt) {
  return `<ul class="rank-list">${items.map((it, i) => `
    <li class="rank-item">
      <div class="medal ${i === 0 ? 'm1' : i === 1 ? 'm2' : i === 2 ? 'm3' : ''}">${i + 1}</div>
      <div class="rname">${it.nombre}</div>
      <div class="rval">${valueFmt(it)}</div>
    </li>`).join('')}</ul>`;
}

function adminRankingsHtml(data) {
  const byIngreso = [...data].sort((a, b) => b.ingreso - a.ingreso);
  const byGanancia = [...data].sort((a, b) => b.ganancia - a.ganancia);
  const byUnidades = [...data].sort((a, b) => b.unidades - a.unidades);
  return `
  <div class="section-title"><h2>Rankings del festival</h2></div>
  <div class="section-sub">Los vendedores con mejor desempeño en cada categoría.</div>
  <div class="grid3">
    <div class="card"><h3>🏆 Mayor ingreso</h3>${rankListHtml(byIngreso, d => fmtCOP(d.ingreso))}</div>
    <div class="card"><h3>💰 Mayor ganancia</h3>${rankListHtml(byGanancia, d => fmtCOP(d.ganancia))}</div>
    <div class="card"><h3>📦 Más unidades vendidas</h3>${rankListHtml(byUnidades, d => fmtNum(d.unidades) + ' u.')}</div>
  </div>`;
}

function adminGraficasHtml(data) {
  return `
  <div class="section-title"><h2>Gráficas del evento</h2></div>
  <div class="section-sub">Visualiza el impacto general del festival para tus informes.</div>
  <div class="grid2">
    <div class="card"><h3>Ingreso por vendedor</h3><div class="chart-box"><canvas id="chIngreso"></canvas></div></div>
    <div class="card"><h3>Ganancia por vendedor</h3><div class="chart-box"><canvas id="chGanancia"></canvas></div></div>
    <div class="card"><h3>Efectivo vs. transferencia (global)</h3><div class="chart-box"><canvas id="chPago"></canvas></div></div>
    <div class="card"><h3>Ingreso total del festival por día</h3><div class="chart-box"><canvas id="chDias"></canvas></div></div>
  </div>`;
}

function makeChart(canvasId, type, data, extraOptions = {}) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type, data,
    options: Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: type === 'doughnut' } } }, extraOptions)
  });
}

function drawAdminCharts(data) {
  const sorted = [...data].sort((a, b) => b.ingreso - a.ingreso).slice(0, 10);
  makeChart('chIngreso', 'bar', { labels: sorted.map(d => d.nombre), datasets: [{ label: 'Ingreso', data: sorted.map(d => d.ingreso), backgroundColor: '#6B2357' }] });
  const sortedG = [...data].sort((a, b) => b.ganancia - a.ganancia).slice(0, 10);
  makeChart('chGanancia', 'bar', { labels: sortedG.map(d => d.nombre), datasets: [{ label: 'Ganancia', data: sortedG.map(d => d.ganancia), backgroundColor: '#5B7553' }] });
  const tE = data.reduce((a, d) => a + d.efectivo, 0), tT = data.reduce((a, d) => a + d.transferencia, 0);
  makeChart('chPago', 'doughnut', { labels: ['Efectivo', 'Transferencia'], datasets: [{ data: [tE, tT], backgroundColor: ['#C9973B', '#6B2357'] }] });
  const byDay = {};
  data.forEach(d => Object.entries(d.ventas).forEach(([date, v]) => { byDay[date] = (byDay[date] || 0) + v.ingresoTotal; }));
  const days = Object.keys(byDay).sort();
  makeChart('chDias', 'line', { labels: days.map(fmtDate), datasets: [{ label: 'Ingreso del día', data: days.map(d => byDay[d]), borderColor: '#8C3B58', backgroundColor: 'rgba(140,59,88,.15)', fill: true, tension: .3 }] });
}

function adminDetalleHtml(data) {
  const selected = state.adminSelected || data[0].username;
  const d = data.find(x => x.username === selected);
  const dates = Object.keys(d.ventas).sort().reverse();
  return `
  <div class="section-title"><h2>Detalle por vendedor</h2></div>
  <div class="card">
    <label class="first">Selecciona un vendedor</label>
    <select id="selVendedor" class="vendedor-select">${data.map(v => `<option value="${v.username}" ${v.username === selected ? 'selected' : ''}>${v.nombre}</option>`).join('')}</select>
  </div>
  <div class="stat-row">
    <div class="stat-card gold"><div class="lbl">Ingreso</div><div class="val">${fmtCOP(d.ingreso)}</div></div>
    <div class="stat-card leaf"><div class="lbl">Ganancia</div><div class="val">${fmtCOP(d.ganancia)}</div></div>
    <div class="stat-card"><div class="lbl">Unidades</div><div class="val">${fmtNum(d.unidades)}</div></div>
    <div class="stat-card"><div class="lbl">Efectivo / Transf.</div><div class="val" style="font-size:16px;">${fmtCOP(d.efectivo)} · ${fmtCOP(d.transferencia)}</div></div>
  </div>
  <div class="card">
    <h3>Productos (${d.products.length})</h3>
    ${d.products.length === 0 ? `<div class="empty">Este vendedor no ha registrado productos.</div>` :
      d.products.map(p => `<div class="product-row"><div>${p.nombre}</div><div>${fmtCOP(p.precioVenta)}</div><div style="color:var(--leaf);font-weight:700;">${fmtCOP(p.ganancia)}</div><div></div></div>`).join('')}
  </div>
  <div class="card table-wrap">
    <h3>Historial de ventas</h3>
    ${dates.length === 0 ? `<div class="empty">Sin registros diarios todavía.</div>` : `
    <table>
      <thead><tr><th>Día</th><th>Unidades</th><th>Ingreso</th><th>Ganancia</th><th>Efectivo</th><th>Transferencia</th></tr></thead>
      <tbody>${dates.map(dt => { const v = d.ventas[dt]; return `<tr><td>${fmtDate(dt)}</td><td>${fmtNum(v.totalUnidades)}</td><td>${fmtCOP(v.ingresoTotal)}</td><td style="color:var(--leaf);font-weight:700;">${fmtCOP(v.gananciaTotal)}</td><td>${fmtCOP(v.efectivo)}</td><td>${fmtCOP(v.transferencia)}</td></tr>`; }).join('')}</tbody>
    </table>`}
  </div>`;
}

function bindDetalle(data) {
  const sel = document.getElementById('selVendedor');
  if (sel) sel.onchange = () => { state.adminSelected = sel.value; render(); };
}

/* ============================================================
   INIT
   ============================================================ */
(async function init() {
  if (APP_PAGE === 'auth') await ensureAdmin();
  state.loading = false;
  render();
})();


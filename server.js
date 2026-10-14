const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =============== НАСТРОЙКИ =============== */
const COMMISSION_RATE = 0.15;   /* 15% компании */

const PRICING = {
  base: 400, perKm: 120, minFare: 500,
  classMult: { 'Эконом': 1.0, 'Комфорт': 1.4, 'Минивэн': 1.7 }
};

const CITY_CENTER = { lat: 42.3167, lng: 69.5950 };

/* Готовые точки Шымкента (для быстрого выбора, если поиск не работает) */
const PRESET_LOCATIONS = [
  { name:'Центр (площадь Аль-Фараби)', lat:42.3167, lng:69.5950 },
  { name:'Туран',                       lat:42.3020, lng:69.6320 },
  { name:'Самал',                       lat:42.3285, lng:69.6215 },
  { name:'Мирзакент',                   lat:42.2960, lng:69.5790 },
  { name:'Нурсат',                      lat:42.3400, lng:69.6100 },
  { name:'Аэропорт Шымкент',            lat:42.3641, lng:69.4787 },
  { name:'ЖД вокзал',                   lat:42.3020, lng:69.5900 },
  { name:'ТРЦ Mega Planet',             lat:42.3230, lng:69.6100 },
  { name:'Металлургов',                 lat:42.3080, lng:69.5750 },
  { name:'Южный рынок',                 lat:42.3050, lng:69.6050 }
];

/* =============== БАЗА =============== */
const users = new Map(), usersByEmail = new Map(), sessions = new Map();
const drivers = new Map(), orders = new Map(), messages = new Map();
const socketsByUser = new Map();
const userBySocket = new Map();

/* =============== УТИЛИТЫ =============== */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const newId = p => p + crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function haversine(a, b){
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function calcPrice(km, cls){
  const m = PRICING.classMult[cls] || 1;
  const raw = (PRICING.base + km * PRICING.perKm) * m;
  return Math.max(PRICING.minFare, Math.round(raw / 50) * 50);
}

/* Надёжный GET через https — работает на всех версиях Node */
function httpsGet(url, extraHeaders = {}){
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'QadamTaxi/1.0 (taxi demo; contact@qadam.local)',
        'Accept': 'application/json',
        ...extraHeaders
      },
      timeout: 8000
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e){ resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

function publicUser(u){ return { id:u.id, email:u.email, name:u.name, role:u.role, phone:u.phone }; }
function publicDriver(d){
  return {
    id:d.id, name:d.name, car:d.car, plate:d.plate, rating:d.rating,
    lat:d.lat, lng:d.lng, status:d.status, trips:d.trips,
    earned:d.earned, earnedGross:d.earnedGross || 0,
    lastSeen: d.lastSeen || null
  };
}
function stateSnapshot(){
  return {
    orders: [...orders.values()],
    drivers: [...drivers.values()].map(publicDriver),
    commissionRate: COMMISSION_RATE
  };
}
function broadcast(payload){
  const msg = JSON.stringify(payload);
  for(const c of wss.clients) if(c.readyState === 1) c.send(msg);
}
function broadcastState(){ broadcast({ type:'state', ...stateSnapshot() }); }
function sendToUser(userId, payload){
  const set = socketsByUser.get(userId);
  if(!set) return;
  const msg = JSON.stringify(payload);
  for(const ws of set) if(ws.readyState === 1) ws.send(msg);
}

/* =============== ПОЛЬЗОВАТЕЛИ =============== */
function createUser({ email, password, name, role, phone, driver }){
  const salt = crypto.randomBytes(16).toString('hex');
  const id = newId('u_');
  const u = { id, email: email.toLowerCase(), name, role, phone: phone || '',
              salt, passwordHash: hashPw(password, salt) };
  users.set(id, u);
  usersByEmail.set(u.email, id);
  if(role === 'driver' && driver){
    drivers.set(id, {
      id, name, email: u.email,
      car: driver.car, plate: driver.plate,
      rating: driver.rating ?? 4.8,
      lat: driver.lat ?? CITY_CENTER.lat,
      lng: driver.lng ?? CITY_CENTER.lng,
      status: driver.status ?? 'offline',
      trips: 0, earned: 0, earnedGross: 0, lastSeen: null
    });
  }
  return u;
}

/* Демо */
createUser({ email:'pass@qadam.kz',  password:'123456', name:'Айгуль',     role:'passenger', phone:'+7 701 111 22 33' });
createUser({ email:'admin@qadam.kz', password:'admin',  name:'Диспетчер',  role:'admin' });
[
  { email:'erlan@qadam.kz',   name:'Ерлан',  car:'Toyota Camry',     plate:'A 123 BC', rating:4.9, status:'online'  },
  { email:'nurlan@qadam.kz',  name:'Нурлан', car:'Hyundai Accent',   plate:'B 456 DE', rating:4.8, status:'online'  },
  { email:'daniyar@qadam.kz', name:'Данияр', car:'Chevrolet Cobalt', plate:'C 789 FG', rating:4.7, status:'online'  },
  { email:'askhat@qadam.kz',  name:'Асхат',  car:'Kia Rio',          plate:'D 012 HI', rating:5.0, status:'offline' },
  { email:'sanzhar@qadam.kz', name:'Санжар', car:'VW Polo',          plate:'E 345 JK', rating:4.6, status:'online'  }
].forEach(d => createUser({
  email:d.email, password:'123456', name:d.name, role:'driver',
  driver:{ car:d.car, plate:d.plate, rating:d.rating, status:d.status }
}));

/* =============== АВТОРИЗАЦИЯ =============== */
function auth(req, res, next){
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = sessions.get(token);
  if(!userId) return res.status(401).json({ error:'Требуется авторизация' });
  req.user = users.get(userId);
  if(!req.user) return res.status(401).json({ error:'Сессия недействительна' });
  next();
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error:'Недостаточно прав' });

/* =============== REST API =============== */
app.post('/api/register', (req, res) => {
  const { email, password, name, role, phone } = req.body || {};
  if(!email || !password || !name || !role)
    return res.status(400).json({ error:'Заполните все поля' });
  if(!['passenger','driver','admin'].includes(role))
    return res.status(400).json({ error:'Неверная роль' });
  if(usersByEmail.has(email.toLowerCase()))
    return res.status(400).json({ error:'Email уже занят' });
  const user = createUser({
    email, password, name, role, phone,
    driver: role === 'driver'
      ? { car:'Не указано', plate:'—', rating:5.0, status:'offline' }
      : null
  });
  const token = newToken(); sessions.set(token, user.id);
  broadcastState();
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const id = usersByEmail.get((email || '').toLowerCase());
  if(!id) return res.status(401).json({ error:'Неверный email или пароль' });
  const u = users.get(id);
  if(hashPw(password || '', u.salt) !== u.passwordHash)
    return res.status(401).json({ error:'Неверный email или пароль' });
  const token = newToken(); sessions.set(token, id);
  res.json({ token, user: publicUser(u) });
});

app.post('/api/logout', auth, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok:true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get('/api/state', auth, (req, res) => res.json(stateSnapshot()));
app.get('/api/preset-locations', (req, res) => res.json(PRESET_LOCATIONS));

/* Диагностика: проверить связь с интернетом */
app.get('/api/health', async (req, res) => {
  const result = { server:'ok', nominatim: 'unknown', time: new Date().toISOString() };
  try {
    const r = await httpsGet('https://nominatim.openstreetmap.org/status?format=json');
    result.nominatim = (r.status === 200) ? 'ok' : ('http ' + r.status);
  } catch(e){
    result.nominatim = 'error: ' + e.message;
  }
  res.json(result);
});

/* =============== ГЕОКОДИРОВАНИЕ =============== */
app.get('/api/geocode/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if(q.length < 3) return res.json({ results: [], source: 'short-query' });

  console.log('[geocode] search:', q);

  /* 1) Локальный поиск по готовым точкам */
  const qLow = q.toLowerCase();
  const local = PRESET_LOCATIONS
    .filter(p => p.name.toLowerCase().includes(qLow))
    .map(p => ({ display_name: p.name, lat: String(p.lat), lon: String(p.lng), source:'local' }));

  /* 2) Если в локальных нашлось — не идём наружу */
  if(local.length >= 3){
    console.log('[geocode] local hit:', local.length);
    return res.json({ results: local, source: 'local' });
  }

  /* 3) Ищем через Nominatim */
  try {
    const url = 'https://nominatim.openstreetmap.org/search'
      + '?q=' + encodeURIComponent(q)
      + '&format=json&limit=6&accept-language=ru&addressdetails=1';
    const r = await httpsGet(url);
    console.log('[geocode] nominatim status:', r.status, 'items:', Array.isArray(r.body) ? r.body.length : 'n/a');

    if(r.status === 200 && Array.isArray(r.body) && r.body.length){
      const merged = [...local];
      for(const item of r.body){
        if(!merged.some(m => Math.abs(Number(m.lat) - Number(item.lat)) < 0.0001
                          && Math.abs(Number(m.lon) - Number(item.lon)) < 0.0001)){
          merged.push({ ...item, source: 'nominatim' });
        }
      }
      return res.json({ results: merged, source: 'nominatim' });
    }

    /* Нет результатов — возвращаем локальные, если есть */
    res.json({ results: local, source: 'local-only' });
  } catch(e){
    console.error('[geocode] nominatim error:', e.message);
    res.json({ results: local, source: 'error', error: e.message });
  }
});

app.get('/api/geocode/reverse', auth, async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if(!Number.isFinite(lat) || !Number.isFinite(lng))
    return res.status(400).json({ error:'bad coords' });

  /* Сначала проверяем, не совпадает ли с готовой точкой */
  const near = PRESET_LOCATIONS.find(p =>
    Math.abs(p.lat - lat) < 0.001 && Math.abs(p.lng - lng) < 0.001);
  if(near) return res.json({ name: near.name, source: 'local' });

  try {
    const url = 'https://nominatim.openstreetmap.org/reverse'
      + '?lat=' + lat + '&lon=' + lng
      + '&format=json&accept-language=ru&zoom=18';
    const r = await httpsGet(url);
    if(r.status === 200 && r.body && r.body.display_name){
      return res.json({ name: r.body.display_name, source: 'nominatim' });
    }
    res.json({ name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, source: 'coords' });
  } catch(e){
    console.error('[reverse] error:', e.message);
    res.json({ name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, source: 'coords-error' });
  }
});

/* =============== QR и адрес сервера =============== */
function localIPs(){
  const nets = os.networkInterfaces(), ips = [];
  for(const name of Object.keys(nets))
    for(const net of nets[name] || [])
      if(net.family === 'IPv4' && !net.internal) ips.push(net.address);
  return ips;
}
app.get('/api/server-info', (req, res) => {
  const port = server.address().port;
  res.json({ port, urls: localIPs().map(ip => `http://${ip}:${port}`), localhost:`http://localhost:${port}` });
});
app.get('/api/qr', async (req, res) => {
  const url = req.query.url;
  if(!url) return res.status(400).send('url required');
  const png = await QRCode.toBuffer(url, { width: 400, margin: 1 });
  res.type('png').send(png);
});

/* =============== ЗАКАЗЫ =============== */
app.post('/api/orders', auth, requireRole('passenger'), (req, res) => {
  try {
    const body = req.body || {};
    const from = body.from;
    const to   = body.to;
    const cls  = String(body.class || 'Эконом');

    console.log('[order] new request from', req.user.email, {
      from: from ? `${from.lat},${from.lng}` : 'нет',
      to:   to   ? `${to.lat},${to.lng}`     : 'нет',
      class: cls
    });

    if(!from || !to)
      return res.status(400).json({ error:'Не указаны точки маршрута' });

    if(typeof from.lat !== 'number' || typeof from.lng !== 'number'
      || typeof to.lat !== 'number' || typeof to.lng !== 'number')
      return res.status(400).json({ error:'Некорректные координаты' });

    if(from.lat === to.lat && from.lng === to.lng)
      return res.status(400).json({ error:'Точки не должны совпадать' });

    if(!PRICING.classMult[cls])
      return res.status(400).json({ error:'Неизвестный класс: ' + cls });

    for(const o of orders.values()){
      if(o.passengerId === req.user.id && !['Завершена','Отменена'].includes(o.status))
        return res.status(400).json({ error:'У вас уже есть активный заказ' });
    }

    const dist = haversine(from, to);
    const price = calcPrice(dist, cls);
    const commission = Math.round(price * COMMISSION_RATE);
    const driverEarning = price - commission;

    const order = {
      id: 'QT-' + String(Date.now()).slice(-6) + Math.floor(Math.random()*90+10),
      passengerId: req.user.id,
      passengerName: req.user.name,
      from: { lat: from.lat, lng: from.lng, name: String(from.name || 'Точка А').slice(0,200) },
      to:   { lat: to.lat,   lng: to.lng,   name: String(to.name   || 'Точка Б').slice(0,200) },
      class: cls,
      distKm: Number(dist.toFixed(2)),
      price, commission, driverEarning,
      status: 'Ищем водителя',
      driverId: null,
      createdAt: Date.now()
    };
    orders.set(order.id, order);
    messages.set(order.id, []);
    broadcastState();
    res.json(order);
    setTimeout(() => tryMatch(order.id), 2000);
  } catch(e){
    console.error('[order] error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

function tryMatch(orderId){
  const order = orders.get(orderId);
  if(!order || order.status !== 'Ищем водителя') return;

  const free = [...drivers.values()].filter(d => d.status === 'online');
  if(!free.length){
    order.status = 'Отменена';
    order.cancelReason = 'Нет свободных водителей';
    return broadcastState();
  }

  const nearest = free
    .map(d => ({ d, dist: haversine(d, order.from), hasGps: !!d.lastSeen }))
    .sort((a,b) => {
      if(a.hasGps !== b.hasGps) return a.hasGps ? -1 : 1;
      return a.dist - b.dist;
    })[0].d;

  order.status = 'Водитель едет';
  order.driverId = nearest.id;
  nearest.status = 'busy';
  broadcastState();

  sendToUser(nearest.id, {
    type: 'new-order',
    order: {
      id: order.id,
      fromName: order.from.name,
      toName: order.to.name,
      price: order.price,
      commission: order.commission,
      driverEarning: order.driverEarning,
      distKm: order.distKm,
      passengerName: order.passengerName
    }
  });
}

app.patch('/api/orders/:id', auth, (req, res) => {
  const order = orders.get(req.params.id);
  if(!order) return res.status(404).json({ error:'Заказ не найден' });
  const { action } = req.body || {};
  const isPassenger = order.passengerId === req.user.id;
  const isDriver    = order.driverId === req.user.id;

  if(action === 'cancel'){
    if(!isPassenger && req.user.role !== 'admin') return res.status(403).json({ error:'Нет прав' });
    if(['Завершена','Отменена'].includes(order.status)) return res.status(400).json({ error:'Заказ уже закрыт' });
    order.status = 'Отменена';
    if(order.driverId){
      const d = drivers.get(order.driverId);
      if(d && d.status === 'busy') d.status = 'online';
    }
    broadcastState();
    if(order.driverId) sendToUser(order.driverId, { type:'order-cancelled', orderId: order.id });
    return res.json(order);
  }

  if(!isDriver) return res.status(403).json({ error:'Только водитель заказа' });

  const map = {
    'arrived': { from:'Водитель едет',     to:'Водитель на месте' },
    'start':   { from:'Водитель на месте', to:'В пути' },
    'finish':  { from:'В пути',            to:'Завершена' }
  };
  const step = map[action];
  if(!step || order.status !== step.from) return res.status(400).json({ error:'Недопустимое действие' });

  order.status = step.to;
  if(action === 'finish'){
    const d = drivers.get(order.driverId);
    if(d){
      d.status = 'online';
      d.trips += 1;
      d.earned += order.driverEarning;
      d.earnedGross = (d.earnedGross || 0) + order.price;
    }
    order.finishedAt = Date.now();
  }
  broadcastState();
  sendToUser(order.passengerId, { type:'order-updated', orderId: order.id, status: order.status });
  res.json(order);
});

app.post('/api/drivers/me/online', auth, requireRole('driver'), (req, res) => {
  const d = drivers.get(req.user.id);
  if(!d) return res.status(404).json({ error:'Профиль водителя не найден' });
  if(d.status === 'busy') return res.status(400).json({ error:'Сначала завершите поездку' });
  d.status = d.status === 'online' ? 'offline' : 'online';
  if(d.status === 'offline') d.lastSeen = null;
  broadcastState();
  res.json(publicDriver(d));
});

/* =============== ЧАТ =============== */
app.get('/api/orders/:id/messages', auth, (req, res) => {
  const order = orders.get(req.params.id);
  if(!order) return res.status(404).json({ error:'Заказ не найден' });
  if(order.passengerId !== req.user.id && order.driverId !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error:'Нет доступа' });
  res.json(messages.get(order.id) || []);
});

app.post('/api/orders/:id/messages', auth, (req, res) => {
  const order = orders.get(req.params.id);
  if(!order) return res.status(404).json({ error:'Заказ не найден' });
  if(order.passengerId !== req.user.id && order.driverId !== req.user.id)
    return res.status(403).json({ error:'Нет доступа' });

  const text = String(req.body?.text || '').trim().slice(0, 500);
  if(!text) return res.status(400).json({ error:'Пустое сообщение' });

  const msg = {
    id: newId('m_'), from: req.user.id,
    fromName: req.user.name, fromRole: req.user.role,
    text, at: Date.now()
  };
  messages.get(order.id).push(msg);

  const target = order.passengerId === req.user.id ? order.driverId : order.passengerId;
  if(target) sendToUser(target, { type:'message', orderId: order.id, message: msg });
  res.json(msg);
});

/* =============== АДМИН =============== */
app.post('/api/admin/clear', auth, requireRole('admin'), (req, res) => {
  orders.clear(); messages.clear();
  for(const d of drivers.values()){
    if(d.status === 'busy') d.status = 'online';
    d.trips = 0; d.earned = 0; d.earnedGross = 0;
  }
  broadcastState();
  res.json({ ok:true });
});

/* =============== WEBSOCKET =============== */
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }

    if(msg.type === 'auth'){
      const userId = sessions.get(msg.token);
      if(!userId){ ws.send(JSON.stringify({ type:'auth-error' })); return; }
      userBySocket.set(ws, userId);
      if(!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
      socketsByUser.get(userId).add(ws);
      ws.send(JSON.stringify({ type:'auth-ok', userId }));
      return;
    }

    const userId = userBySocket.get(ws);
    if(!userId) return;

    if(msg.type === 'driver-location'){
      const d = drivers.get(userId);
      if(!d) return;
      if(typeof msg.lat !== 'number' || typeof msg.lng !== 'number') return;
      d.lat = msg.lat; d.lng = msg.lng; d.lastSeen = Date.now();
      const out = JSON.stringify({
        type: 'driver-moved', driverId: userId,
        lat: msg.lat, lng: msg.lng, status: d.status
      });
      for(const c of wss.clients){
        if(c === ws) continue;
        if(c.readyState === 1) c.send(out);
      }
    }
  });

  ws.on('close', () => {
    const userId = userBySocket.get(ws);
    if(userId){
      const set = socketsByUser.get(userId);
      if(set){ set.delete(ws); if(!set.size) socketsByUser.delete(userId); }
      userBySocket.delete(ws);
    }
  });

  ws.send(JSON.stringify({ type:'state', ...stateSnapshot() }));
});

/* =============== ЗАПУСК =============== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ips = localIPs();
  console.log('\n════════════════════════════════════════════════');
  console.log('  🚕 QADAM TAXI — сервер запущен');
  console.log('════════════════════════════════════════════════');
  console.log(`  💰 Комиссия компании: ${(COMMISSION_RATE * 100).toFixed(0)}%`);
  console.log('\n  💻 Оператор:');
  console.log(`     http://localhost:${PORT}\n`);
  if(ips.length){
    console.log('  📱 Телефоны:');
    ips.forEach(ip => console.log(`     http://${ip}:${PORT}`));
    console.log('');
  }
  console.log('  👤 Демо-аккаунты:');
  console.log('     admin@qadam.kz / admin      (оператор)');
  console.log('     pass@qadam.kz  / 123456     (пассажир)');
  console.log('     erlan@qadam.kz / 123456     (водитель)');
  console.log('\n  🔍 Проверка связи с интернетом:');
  console.log(`     http://localhost:${PORT}/api/health`);
  console.log('\n  ⛔ Не закрывай окно, пока работает такси!');
  console.log('════════════════════════════════════════════════\n');
});
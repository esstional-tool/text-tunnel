// 큰 파일을 PC 에 바로 저장 (이슈 #55) — 메신저(server.js)와 분리된 모듈.
// 보내는 쪽(휴대폰)이 제안(offer)을 올리고, 받는 쪽(PC)이 "받기"로 연결을 열면, 보내는 쪽이 조각을 올리고
// 서버는 그 조각을 받는 쪽 응답으로 그대로 흘려보낸다. 조각은 한 번에 하나만 메모리에 있고, 디스크에는 아무것도 쓰지 않는다.
// 받는 쪽이 밀리면(write 가 끝나지 않으면) 보내는 쪽 응답을 늦춰서 기다리게 한다 (backpressure).
// 방마다 한 번에 한 파일만 흐른다. 이어 받기는 없다 — 끊기면 처음부터 다시 보낸다 (조각 하나 단위 재시도는 state 로 맞춘다).
module.exports = ({ readBody, send, crypto }) => {
  const MAX_BYTES = (Number(process.env.STREAM_MAX_MB) || 1024) * 1024 * 1024;
  const CHUNK_MAX = 16 * 1024 * 1024;   // 보내는 쪽은 8MB 씩 올린다. 여유를 둔 상한
  const OFFER_TTL = 10 * 60 * 1000;     // 받는 쪽이 "받기"를 누르기까지
  const STALL = 2 * 60 * 1000;          // 이만큼 조각이 안 오면 멈춘 것으로 본다

  const notify = (room, pred, ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const m of room.members.values()) if (pred(m)) m.res?.write(line);
  };

  // 흐름을 끝낸다 (실패·취소·만료). 받는 쪽 응답은 끊어서 파일이 덜 받아진 것을 알 수 있게 한다
  function fail(room, s, reason) {
    if (room.stream !== s) return;
    room.stream = null;
    clearTimeout(s.timer);
    s.state = 'failed';
    if (s.receiver && !s.receiver.writableEnded) s.receiver.destroy();
    notify(room, () => true, { type: 'streamfail', sid: s.id, reason, name: s.name });
  }

  function arm(room, s, ms, reason) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => fail(room, s, reason), ms);
  }

  // 조각 하나를 받는 쪽 응답에 쓰고, 실제로 내보낼 때까지 기다린다 (false = 받는 쪽이 끊김)
  function pushTo(res, buf) {
    return new Promise((resolve) => {
      if (res.destroyed || res.writableEnded) return resolve(false);
      const gone = () => resolve(false);
      res.once('close', gone);
      res.write(buf, (err) => { res.removeListener('close', gone); resolve(!err); });
    });
  }

  return function handle(req, res, url, a) {
    const p = url.pathname;
    const { room, member } = a;
    const sid = url.searchParams.get('sid') || '';
    const s = room.stream;
    const mine = s && s.id === sid;

    // 보내겠다고 제안: { name, size, mime }
    if (p === '/api/stream/offer' && req.method === 'POST') {
      return readBody(req, 4096, (err, body) => {
        if (err) return send(res, 400, 'bad request');
        let j;
        try { j = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
        const size = Number(j?.size);
        if (!Number.isInteger(size) || size <= 0) return send(res, 400, { error: '파일 크기가 올바르지 않아요' });
        if (size > MAX_BYTES) return send(res, 413, { error: `한 번에 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB 까지 보낼 수 있어요` });
        if (room.stream) return send(res, 409, { error: '지금 다른 파일을 보내는 중이에요. 끝난 뒤 다시 해 주세요' });
        const name = String(j?.name || 'file').slice(0, 200);
        // 조각을 쌓지 않고 흘리므로 서버가 HEIC 를 JPG 로 바꿀 수 없다 — 이 방식으로는 보낼 수 없다고 알린다 (이슈 #59)
        if (/\.(heic|heif)$/i.test(name) || /hei[cf]/.test(String(j?.mime || ''))) return send(res, 415, { error: 'HEIC 사진은 \'PC에 바로 저장\'으로 보낼 수 없어요. 일반 보내기를 써 주세요' });
        const next = {
          id: crypto.randomUUID(), from: member.id, fromName: member.name, name, size,
          mime: String(j?.mime || 'application/octet-stream').slice(0, 100),
          received: 0, state: 'offered', receiver: null, timer: null,
        };
        room.stream = next;
        arm(room, next, OFFER_TTL, 'expired');
        // 보낸 사람 말고 같은 방의 다른 기기에 알린다 (PC 가 "받기" 카드를 띄운다)
        notify(room, (m) => m.id !== member.id, { type: 'streamoffer', sid: next.id, name, size: next.size, mime: next.mime, from: member.id, fromName: member.name });
        return send(res, 200, { sid: next.id });
      });
    }

    // 받는 쪽이 "받기"를 눌러 연결을 연다 (긴 응답): 이 응답으로 조각이 흘러 들어간다
    if (p === '/api/stream/receive' && req.method === 'GET') {
      if (!mine || s.state !== 'offered') return send(res, 409, { error: '이미 끝났거나 받을 수 없는 파일이에요' });
      if (member.id === s.from) return send(res, 403, 'forbidden');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': s.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(s.name)}`,
        'Cache-Control': 'no-store',
      });
      s.receiver = res;
      res.flushHeaders(); // 헤더를 바로 보내야 받는 쪽이 읽기를 시작한다
      s.state = 'ready';
      arm(room, s, STALL, 'stalled');
      res.on('close', () => { if (room.stream === s && s.state !== 'done') fail(room, s, 'receiver-gone'); });
      notify(room, (m) => m.id === s.from, { type: 'streamready', sid: s.id, name: s.name });
      return;
    }

    // 보내는 쪽이 준비됐는지 묻는다 (기다리는 동안 폴링). 받은 바이트 수도 알려 줘서 끊겼을 때 거기서 이어 보낸다
    if (p === '/api/stream/state' && req.method === 'GET') {
      if (!mine) return send(res, 200, { state: 'gone', received: 0 });
      return send(res, 200, { state: s.state, received: s.received });
    }

    // 조각 하나: ?sid&offset= — 본문은 raw 바이트. 받는 쪽에 쓰고 나서 응답한다 (그래서 밀리면 여기서 기다린다)
    if (p === '/api/stream/chunk' && req.method === 'POST') {
      if (!mine || member.id !== s.from) return send(res, 410, { error: '파일 보내기가 끝났어요' });
      if (s.state !== 'ready' && s.state !== 'sending') return send(res, 409, { error: '받는 쪽이 아직 준비되지 않았어요' });
      const offset = Number(url.searchParams.get('offset'));
      if (offset !== s.received) return send(res, 409, { error: '조각 순서가 어긋났어요', received: s.received });
      const limit = Math.min(CHUNK_MAX, s.size - offset);
      return readBody(req, limit, (err, buf) => {
        if (err) return send(res, 413, 'chunk too large');
        if (!mine || room.stream !== s) return send(res, 410, { error: '파일 보내기가 끝났어요' });
        if (!buf.length || buf.length > limit) return send(res, 400, 'bad chunk');
        s.state = 'sending';
        arm(room, s, STALL, 'stalled');
        pushTo(s.receiver, buf).then(async (ok) => {
          if (!ok) { fail(room, s, 'receiver-gone'); return send(res, 410, { error: '받는 쪽이 끊겼어요' }); }
          s.received += buf.length;
          if (s.received < s.size) { s.state = 'ready'; return send(res, 200, 'more'); }
          // 마지막 조각: 받는 쪽 응답을 끝내고 흐름을 닫는다
          s.state = 'done';
          clearTimeout(s.timer);
          room.stream = null;
          s.receiver.end();
          notify(room, (m) => m.id !== s.from, { type: 'streamdone', sid: s.id, name: s.name, size: s.size });
          send(res, 200, 'done');
        });
      });
    }

    // 취소: 보내는 쪽이든 받는 쪽이든 누를 수 있다 (받는 쪽 "거절"도 여기)
    if (p === '/api/stream/cancel' && req.method === 'POST') {
      if (mine) fail(room, s, member.id === s.from ? 'cancelled' : 'declined');
      return send(res, 200, 'ok');
    }

    send(res, 404, 'not found');
    return true;
  };
};

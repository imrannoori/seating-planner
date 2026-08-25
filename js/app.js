(function () {
  'use strict';

  /* ===================== State ===================== */

  const STORAGE_CURRENT = 'seatingPlanner.current';
  const STORAGE_SAVES = 'seatingPlanner.saves';
  const DEFAULT_ELEMENT_COLOR = '#c9b7a0';
  const UNDO_LIMIT = 50;

  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function defaultState() {
    return {
      eventName: 'Untitled Event',
      eventSubtitle: '',
      maxTables: 8,
      venueWidth: 1600,
      venueHeight: 1000,
      tables: [],
      guests: [],
      groups: [],
      rules: [],
      elements: []
    };
  }

  let state = loadCurrent() || defaultState();
  let zoom = 1;
  let selectedTableId = null;
  let selectedElementId = null;
  let selectedRuleType = 'together';
  let undoStack = [];

  /* ===================== Persistence ===================== */

  function loadCurrent() {
    try {
      const raw = localStorage.getItem(STORAGE_CURRENT);
      if (!raw) return null;
      return normalizeState(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  function normalizeState(s) {
    const d = defaultState();
    const merged = Object.assign(d, s || {});
    merged.guests = (merged.guests || []).map(g => Object.assign({ meal: '', groupId: null }, g));
    merged.groups = merged.groups || [];
    merged.rules = merged.rules || [];
    merged.tables = (merged.tables || []).map(t => Object.assign({}, t, {
      seatAssignments: t.seatAssignments || new Array(t.seats).fill(null)
    }));
    merged.elements = (merged.elements || []).map(el => Object.assign({ color: DEFAULT_ELEMENT_COLOR, shape: 'rect' }, el));
    return merged;
  }

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    const indicator = document.getElementById('saveIndicator');
    if (indicator) indicator.textContent = 'Saving…';
    saveTimer = setTimeout(() => {
      localStorage.setItem(STORAGE_CURRENT, JSON.stringify(state));
      if (indicator) indicator.textContent = 'Last saved ' + new Date().toLocaleTimeString();
    }, 400);
  }

  function getSaves() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_SAVES) || '[]');
    } catch (e) {
      return [];
    }
  }

  function setSaves(list) {
    localStorage.setItem(STORAGE_SAVES, JSON.stringify(list));
  }

  /* ===================== Helpers ===================== */

  function findTable(id) { return state.tables.find(t => t.id === id); }
  function findGuest(id) { return state.guests.find(g => g.id === id); }
  function findElement(id) { return state.elements.find(e => e.id === id); }
  function findGroup(id) { return state.groups.find(g => g.id === id); }

  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  }

  function seatOwner(table, index) {
    const gid = table.seatAssignments[index];
    return gid ? findGuest(gid) : null;
  }

  function unassignedGuests() {
    const assigned = new Set();
    state.tables.forEach(t => t.seatAssignments.forEach(gid => { if (gid) assigned.add(gid); }));
    return state.guests.filter(g => !assigned.has(g.id));
  }

  function guestTableInfo(guestId) {
    for (const t of state.tables) {
      const idx = t.seatAssignments.indexOf(guestId);
      if (idx !== -1) return { table: t, seatIndex: idx };
    }
    return null;
  }

  function unassignGuest(guestId) {
    const info = guestTableInfo(guestId);
    if (info) info.table.seatAssignments[info.seatIndex] = null;
  }

  function seatGuest(guestId, table, seatIndex) {
    unassignGuest(guestId);
    table.seatAssignments[seatIndex] = guestId;
  }

  function placeSingleGuestInSeat(guestId, table, seatIndex) {
    const targetOccupant = table.seatAssignments[seatIndex];
    if (targetOccupant && targetOccupant !== guestId) {
      const fromInfo = guestTableInfo(guestId);
      table.seatAssignments[seatIndex] = guestId;
      if (fromInfo) fromInfo.table.seatAssignments[fromInfo.seatIndex] = targetOccupant;
    } else {
      seatGuest(guestId, table, seatIndex);
    }
  }

  function handleSeatDrop(guestId, table, seatIndex) {
    const guest = findGuest(guestId);
    if (!guest) return;
    pushUndo();
    const group = guest.groupId ? findGroup(guest.groupId) : null;
    const others = group ? group.guestIds.filter(id => id !== guestId).map(findGuest).filter(Boolean) : [];

    if (others.length) {
      let emptyCount = 0;
      table.seatAssignments.forEach((gid, idx) => { if (idx !== seatIndex && !gid) emptyCount++; });

      if (emptyCount >= others.length) {
        const allNames = [guest, ...others].map(g => g.name).join(', ');
        const label = group.name ? `"${group.name}"` : 'this group';
        if (window.confirm(`Seat ${label} together at ${table.name}?\n\n${allNames}`)) {
          placeSingleGuestInSeat(guestId, table, seatIndex);
          let idx = 0;
          others.forEach(other => {
            while (idx < table.seatAssignments.length && table.seatAssignments[idx]) idx++;
            if (idx < table.seatAssignments.length) seatGuest(other.id, table, idx);
            idx++;
          });
          render();
          return;
        }
      } else {
        toast(`Only ${emptyCount} open seat(s) at ${table.name} — not enough room for all of ${group.name || 'the group'} (${others.length + 1}).`);
      }
    }
    placeSingleGuestInSeat(guestId, table, seatIndex);
    render();
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function csvEscape(val) {
    const s = String(val == null ? '' : val);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* ===================== Undo ===================== */

  function pushUndoSnapshot(snapshot) {
    undoStack.push(snapshot);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    updateUndoButton();
  }

  function pushUndo() {
    pushUndoSnapshot(JSON.stringify(state));
  }

  function updateUndoButton() {
    const btn = document.getElementById('btnUndo');
    if (btn) btn.disabled = undoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) { toast('Nothing to undo'); return; }
    const prev = undoStack.pop();
    state = normalizeState(JSON.parse(prev));
    selectedTableId = null;
    selectedElementId = null;
    closePopover();
    closeElementPopover();
    updateUndoButton();
    render();
    toast('Undid last action');
  }

  document.getElementById('btnUndo').addEventListener('click', undo);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      undo();
    }
  });

  /* ===================== Relationship rules & violations ===================== */

  function computeViolations() {
    const violations = [];
    state.rules.forEach(rule => {
      const members = rule.guestIds.map(findGuest).filter(Boolean);
      if (members.length < 2) return;
      const seatedMembers = members.map(g => ({ guest: g, info: guestTableInfo(g.id) })).filter(m => m.info);

      if (rule.type === 'together') {
        const tableIds = new Set(seatedMembers.map(m => m.info.table.id));
        if (seatedMembers.length >= 2 && tableIds.size > 1) {
          violations.push({
            rule, type: 'together',
            message: `${members.map(g => g.name).join(', ')} must sit together but are split across ${tableIds.size} tables.`,
            tableIds: [...tableIds]
          });
        }
      } else if (rule.type === 'apart') {
        const byTable = {};
        seatedMembers.forEach(m => {
          const tid = m.info.table.id;
          (byTable[tid] = byTable[tid] || []).push(m.guest);
        });
        Object.entries(byTable).forEach(([tid, guestsAtTable]) => {
          if (guestsAtTable.length >= 2) {
            const t = findTable(tid);
            violations.push({
              rule, type: 'apart',
              message: `${guestsAtTable.map(g => g.name).join(' & ')} should be kept apart but are both seated at ${t ? t.name : 'the same table'}.`,
              tableIds: [tid]
            });
          }
        });
      }
    });
    return violations;
  }

  /* ===================== Seat geometry ===================== */

  function mixColor(hexA, hexB, t) {
    const a = [parseInt(hexA.slice(1, 3), 16), parseInt(hexA.slice(3, 5), 16), parseInt(hexA.slice(5, 7), 16)];
    const b = [parseInt(hexB.slice(1, 3), 16), parseInt(hexB.slice(3, 5), 16), parseInt(hexB.slice(5, 7), 16)];
    const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return `rgb(${m[0]}, ${m[1]}, ${m[2]})`;
  }

  function tableSize(table) {
    if (table.shape === 'round') {
      const r = Math.max(46, 30 + table.seats * 6);
      return { w: r * 2, h: r * 2, r };
    } else {
      const perSide = Math.max(1, Math.ceil(table.seats / 2));
      const w = Math.max(110, perSide * 52);
      const h = 90;
      return { w, h };
    }
  }

  function seatPositions(table) {
    const positions = [];
    if (table.shape === 'round') {
      const { r } = tableSize(table);
      const seatR = r + 22;
      for (let i = 0; i < table.seats; i++) {
        const angle = (i / table.seats) * Math.PI * 2 - Math.PI / 2;
        positions.push({
          x: r + seatR * Math.cos(angle),
          y: r + seatR * Math.sin(angle)
        });
      }
    } else {
      const { w, h } = tableSize(table);
      const n = table.seats;
      const topCount = Math.ceil(n / 2);
      const bottomCount = n - topCount;
      const margin = 18;
      const usableW = w - margin * 2;
      for (let i = 0; i < topCount; i++) {
        const x = topCount === 1 ? w / 2 : margin + (usableW * i) / (topCount - 1);
        positions.push({ x, y: -20 });
      }
      for (let i = 0; i < bottomCount; i++) {
        const x = bottomCount === 1 ? w / 2 : margin + (usableW * i) / (bottomCount - 1);
        positions.push({ x, y: h + 20 });
      }
    }
    return positions;
  }

  /* ===================== Rendering ===================== */

  const floorEl = document.getElementById('canvasFloor');
  const stageEl = document.getElementById('canvasStage');

  function render() {
    document.getElementById('eventName').value = state.eventName;
    document.getElementById('eventSubtitle').value = state.eventSubtitle || '';
    document.getElementById('maxTablesInput').value = state.maxTables;
    document.getElementById('venueWidthInput').value = state.venueWidth;
    document.getElementById('venueHeightInput').value = state.venueHeight;

    applyZoom();

    renderGuestLists();
    renderFloor();
    persist();
  }

  function renderDashboard() {
    const unassigned = unassignedGuests();
    document.getElementById('statInvited').textContent = state.guests.length;
    document.getElementById('statSeated').textContent = state.guests.length - unassigned.length;
    document.getElementById('statUnassigned').textContent = unassigned.length;
    document.getElementById('statTables').textContent = `${state.tables.length} / ${state.maxTables}`;

    const violations = computeViolations();
    const badge = document.getElementById('rulesWarnBadge');
    if (violations.length) {
      badge.hidden = false;
      badge.textContent = violations.length;
    } else {
      badge.hidden = true;
    }
  }

  function renderGuestLists() {
    const unassigned = unassignedGuests();
    const unassignedListEl = document.getElementById('unassignedList');
    const seatedListEl = document.getElementById('seatedList');
    const search = document.getElementById('guestSearch').value.trim().toLowerCase();

    unassignedListEl.innerHTML = '';
    seatedListEl.innerHTML = '';

    document.getElementById('guestCount').textContent = state.guests.length;
    document.getElementById('unassignedCount').textContent = unassigned.length;
    document.getElementById('seatedCount').textContent = state.guests.length - unassigned.length;

    const seenGroups = new Set();
    const items = [];
    unassigned.forEach(g => {
      if (g.groupId) {
        if (seenGroups.has(g.groupId)) return;
        seenGroups.add(g.groupId);
        const group = findGroup(g.groupId);
        const members = unassigned.filter(x => x.groupId === g.groupId);
        const matches = !search ||
          members.some(m => m.name.toLowerCase().includes(search)) ||
          (group && group.name.toLowerCase().includes(search));
        if (matches) items.push({ kind: 'group', group, members });
      } else if (!search || g.name.toLowerCase().includes(search)) {
        items.push({ kind: 'guest', guest: g });
      }
    });

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty-note';
      li.textContent = !state.guests.length
        ? 'No guests yet — add your first guest above.'
        : (unassigned.length ? 'No matches.' : 'Everyone is seated ✦');
      unassignedListEl.appendChild(li);
    }
    items.forEach(item => {
      unassignedListEl.appendChild(item.kind === 'group' ? groupCard(item.group, item.members) : guestChip(item.guest, null));
    });

    const seated = state.guests.filter(g => !unassigned.includes(g));
    const filteredSeated = seated.filter(g => !search || g.name.toLowerCase().includes(search));
    if (!filteredSeated.length) {
      const li = document.createElement('li');
      li.className = 'empty-note';
      li.textContent = 'No guests seated yet.';
      seatedListEl.appendChild(li);
    }
    filteredSeated.forEach(g => {
      const info = guestTableInfo(g.id);
      seatedListEl.appendChild(guestChip(g, info ? info.table : null));
    });

    renderDashboard();
  }

  function assignGuestToTableQuick(guestId, tableId) {
    if (!tableId) {
      pushUndo();
      unassignGuest(guestId);
      render();
      return;
    }
    const table = findTable(tableId);
    if (!table) { render(); return; }
    const emptyIdx = table.seatAssignments.findIndex(gid => !gid);
    if (emptyIdx === -1) {
      toast(`${table.name} is full.`);
      render();
      return;
    }
    handleSeatDrop(guestId, table, emptyIdx);
  }

  function buildTableSelect(currentTableId, guestId) {
    const select = document.createElement('select');
    select.className = 'chip-table-select';
    select.addEventListener('mousedown', e => e.stopPropagation());
    select.addEventListener('click', e => e.stopPropagation());

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Unassigned';
    select.appendChild(noneOpt);

    state.tables.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      const isCurrent = t.id === currentTableId;
      const full = !isCurrent && t.seatAssignments.every(Boolean);
      opt.textContent = t.name + (full ? ' (Full)' : '');
      opt.disabled = full;
      select.appendChild(opt);
    });

    select.value = currentTableId || '';
    select.addEventListener('change', (e) => {
      assignGuestToTableQuick(guestId, e.target.value);
    });

    return select;
  }

  function groupCard(group, members) {
    const li = document.createElement('li');
    li.className = 'group-card';
    li.draggable = true;
    const repId = members[0].id;
    li.dataset.guestId = repId;

    const title = document.createElement('div');
    title.className = 'group-card-title';
    title.textContent = '👪 ' + (group ? group.name : 'Group');
    li.appendChild(title);

    const namesEl = document.createElement('div');
    namesEl.className = 'group-card-members';
    namesEl.textContent = members.map(m => m.name).join(', ');
    li.appendChild(namesEl);

    if (group && group.guestIds.length > members.length) {
      const meta = document.createElement('div');
      meta.className = 'group-card-meta';
      meta.textContent = `${group.guestIds.length - members.length} already seated elsewhere in this group`;
      li.appendChild(meta);
    }

    li.appendChild(buildTableSelect('', repId));

    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/guest-id', repId);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));

    return li;
  }

  function guestChip(guest, table) {
    const li = document.createElement('li');
    li.className = 'guest-chip';
    li.draggable = true;
    li.dataset.guestId = guest.id;

    const top = document.createElement('div');
    top.className = 'guest-chip-top';

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = guest.name;
    top.appendChild(name);

    const rightWrap = document.createElement('span');
    rightWrap.style.display = 'flex';
    rightWrap.style.alignItems = 'center';
    rightWrap.style.gap = '5px';
    rightWrap.style.flexShrink = '0';

    if (guest.groupId) {
      const group = findGroup(guest.groupId);
      if (group) {
        const tag = document.createElement('span');
        tag.className = 'chip-group-tag';
        tag.textContent = group.name;
        rightWrap.appendChild(tag);
      }
    }

    const remove = document.createElement('button');
    remove.className = 'chip-remove';
    remove.type = 'button';
    remove.title = 'Remove guest';
    remove.textContent = '✕';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndo();
      state.guests = state.guests.filter(g => g.id !== guest.id);
      state.tables.forEach(t => {
        t.seatAssignments = t.seatAssignments.map(gid => gid === guest.id ? null : gid);
      });
      state.groups.forEach(gr => { gr.guestIds = gr.guestIds.filter(id => id !== guest.id); });
      state.groups = state.groups.filter(gr => gr.guestIds.length > 1);
      state.rules.forEach(r => { r.guestIds = r.guestIds.filter(id => id !== guest.id); });
      render();
    });
    rightWrap.appendChild(remove);
    top.appendChild(rightWrap);
    li.appendChild(top);

    li.appendChild(buildTableSelect(table ? table.id : '', guest.id));

    const mealInput = document.createElement('input');
    mealInput.type = 'text';
    mealInput.className = 'chip-meal-input';
    mealInput.placeholder = 'Meal / dietary…';
    mealInput.value = guest.meal || '';
    mealInput.addEventListener('mousedown', e => e.stopPropagation());
    mealInput.addEventListener('click', e => e.stopPropagation());
    mealInput.addEventListener('input', (e) => {
      guest.meal = e.target.value;
      persist();
    });
    li.appendChild(mealInput);

    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/guest-id', guest.id);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));

    return li;
  }

  function renderFloor() {
    const violations = computeViolations();
    floorEl.innerHTML = '';
    if (!state.tables.length && !state.elements.length) {
      const empty = document.createElement('div');
      empty.className = 'canvas-empty-state';
      empty.innerHTML = '<span class="canvas-empty-icon">✦</span><span class="canvas-empty-title">Your floor plan is empty</span><span class="canvas-empty-hint">Add a table to begin seating guests</span>';
      floorEl.appendChild(empty);
    }
    state.elements.forEach(el => floorEl.appendChild(renderVenueElement(el)));
    state.tables.forEach(t => floorEl.appendChild(renderTable(t, violations)));
    if (selectedTableId && !findTable(selectedTableId)) closePopover();
    if (selectedElementId && !findElement(selectedElementId)) closeElementPopover();
  }

  function elementIcon(el) {
    return (ELEMENT_DEFS[el.type] || {}).icon || '▦';
  }

  function renderVenueElement(el) {
    const node = document.createElement('div');
    node.className = 'venue-node' + (el.shape === 'oval' ? ' shape-oval' : '') + (el.id === selectedElementId ? ' selected' : '');
    node.style.left = el.x + 'px';
    node.style.top = el.y + 'px';
    node.style.width = el.w + 'px';
    node.style.height = el.h + 'px';
    node.dataset.elId = el.id;
    const color = el.color || DEFAULT_ELEMENT_COLOR;
    node.style.setProperty('--el-border', color);
    node.style.setProperty('--el-fill', mixColor('#fffcf8', color, 0.16));
    node.style.setProperty('--el-stripe', mixColor('#fffcf8', color, 0.28));

    const content = document.createElement('div');
    content.className = 'venue-node-content';
    const icon = document.createElement('span');
    icon.className = 'venue-node-icon';
    icon.textContent = elementIcon(el);
    const label = document.createElement('span');
    label.className = 'venue-node-label';
    label.textContent = el.label;
    content.appendChild(icon);
    content.appendChild(label);
    node.appendChild(content);

    const del = document.createElement('button');
    del.className = 'venue-delete';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndo();
      state.elements = state.elements.filter(x => x.id !== el.id);
      if (selectedElementId === el.id) closeElementPopover();
      render();
    });
    node.appendChild(del);

    makeResizable(node, el);
    makeDraggableNode(node, el, 'element');

    node.addEventListener('click', (e) => {
      e.stopPropagation();
      if (node.classList.contains('just-dragged') || node.classList.contains('just-resized')) return;
      openElementPopover(el, node);
    });

    return node;
  }

  const RESIZE_HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  function makeResizable(node, el) {
    RESIZE_HANDLES.forEach(pos => {
      const handle = document.createElement('div');
      handle.className = 'resize-handle rh-' + pos;
      handle.addEventListener('click', e => e.stopPropagation());
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const startW = el.w, startH = el.h, startElX = el.x, startElY = el.y;
        const preSnapshot = JSON.stringify(state);
        let moved = false;

        function onMove(ev) {
          const dx = (ev.clientX - startX) / zoom;
          const dy = (ev.clientY - startY) / zoom;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
          let newW = startW, newH = startH, newX = startElX, newY = startElY;
          if (pos.includes('e')) newW = Math.max(40, startW + dx);
          if (pos.includes('w')) { newW = Math.max(40, startW - dx); newX = startElX + (startW - newW); }
          if (pos.includes('s')) newH = Math.max(30, startH + dy);
          if (pos.includes('n')) { newH = Math.max(30, startH - dy); newY = startElY + (startH - newH); }
          el.w = newW; el.h = newH;
          el.x = Math.max(0, newX);
          el.y = Math.max(0, newY);
          node.style.width = el.w + 'px';
          node.style.height = el.h + 'px';
          node.style.left = el.x + 'px';
          node.style.top = el.y + 'px';
        }
        function onUp() {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (moved) {
            pushUndoSnapshot(preSnapshot);
            node.classList.add('just-resized');
            setTimeout(() => node.classList.remove('just-resized'), 0);
            persist();
          }
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
      node.appendChild(handle);
    });
  }

  function renderTable(table, violations) {
    const { w, h } = tableSize(table);
    const node = document.createElement('div');
    node.className = 'table-node' + (table.id === selectedTableId ? ' selected' : '');
    node.style.left = table.x + 'px';
    node.style.top = table.y + 'px';
    node.style.width = w + 'px';
    node.style.height = h + 'px';
    node.dataset.tableId = table.id;

    const occupiedCount = table.seatAssignments.filter(Boolean).length;
    const ratio = table.seats ? occupiedCount / table.seats : 0;

    if (table.shape === 'round') {
      const ring = document.createElement('div');
      ring.className = 'table-ring';
      const pct = Math.round(ratio * 100);
      ring.style.background = `conic-gradient(var(--accent) ${pct}%, var(--ring-track) 0)`;
      node.appendChild(ring);
    }

    const shape = document.createElement('div');
    shape.className = 'table-shape ' + (table.shape === 'round' ? 'round' : 'rect');
    shape.style.background = mixColor('#fffdfb', '#f3d9ca', ratio);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'table-name-input';
    nameInput.value = table.name;
    nameInput.addEventListener('mousedown', e => e.stopPropagation());
    nameInput.addEventListener('click', e => e.stopPropagation());
    nameInput.addEventListener('input', (e) => {
      table.name = e.target.value || table.name;
      if (selectedTableId === table.id) {
        const popoverInput = document.getElementById('tableNameInput');
        if (document.activeElement !== popoverInput) popoverInput.value = table.name;
      }
      persist();
      renderGuestLists();
    });
    shape.appendChild(nameInput);

    const sub = document.createElement('div');
    sub.className = 'table-sub';
    sub.textContent = `${occupiedCount}/${table.seats} seated`;
    shape.appendChild(sub);

    node.appendChild(shape);

    if (table.shape !== 'round') {
      const bar = document.createElement('div');
      bar.className = 'table-progress-track';
      const fill = document.createElement('div');
      fill.className = 'table-progress-fill';
      fill.style.width = Math.round(ratio * 100) + '%';
      bar.appendChild(fill);
      node.appendChild(bar);
    }

    const tableViolations = violations.filter(v => v.tableIds.includes(table.id));
    if (tableViolations.length) {
      const warn = document.createElement('div');
      warn.className = 'table-warning';
      warn.textContent = '!';
      warn.title = tableViolations.map(v => v.message).join('\n');
      warn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRulesModal();
      });
      node.appendChild(warn);
    }

    const positions = seatPositions(table);
    positions.forEach((pos, i) => {
      const guest = seatOwner(table, i);
      const seat = document.createElement('div');
      seat.className = 'seat' + (guest ? ' occupied' : '');
      seat.style.left = pos.x + 'px';
      seat.style.top = pos.y + 'px';
      seat.dataset.tableId = table.id;
      seat.dataset.seatIndex = i;
      seat.draggable = !!guest;

      if (guest) {
        const ini = document.createElement('span');
        ini.className = 'seat-initials';
        ini.textContent = initials(guest.name);
        seat.appendChild(ini);

        const label = document.createElement('div');
        label.className = 'seat-label';
        label.textContent = guest.name;
        seat.appendChild(label);

        seat.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          e.dataTransfer.setData('text/guest-id', guest.id);
          e.dataTransfer.effectAllowed = 'move';
        });
      } else {
        seat.title = 'Drop a guest here';
      }

      seat.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        seat.classList.add('drop-hover');
      });
      seat.addEventListener('dragleave', () => seat.classList.remove('drop-hover'));
      seat.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        seat.classList.remove('drop-hover');
        const guestId = e.dataTransfer.getData('text/guest-id');
        if (!guestId) return;
        handleSeatDrop(guestId, table, i);
      });

      node.appendChild(seat);
    });

    makeDraggableNode(node, table, 'table', shape);

    node.addEventListener('click', (e) => {
      e.stopPropagation();
      if (node.classList.contains('just-dragged')) return;
      openPopover(table, node);
    });

    return node;
  }

  /* ===================== Node dragging (tables & elements) ===================== */

  function makeDraggableNode(node, model, kind, handleEl) {
    const handle = handleEl || node;
    let startX, startY, origX, origY, moved, preSnapshot;

    function onMouseMove(e) {
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      const maxX = Math.max(0, state.venueWidth / zoom - node.offsetWidth);
      const maxY = Math.max(0, state.venueHeight / zoom - node.offsetHeight);
      model.x = Math.max(0, Math.min(maxX, origX + dx));
      model.y = Math.max(0, Math.min(maxY, origY + dy));
      node.style.left = model.x + 'px';
      node.style.top = model.y + 'px';
      if (kind === 'table' && selectedTableId === model.id) positionPopover(node);
      if (kind === 'element' && selectedElementId === model.id) positionElementPopover(node);
    }

    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      node.classList.remove('dragging');
      if (moved) {
        node.classList.add('just-dragged');
        setTimeout(() => node.classList.remove('just-dragged'), 0);
        pushUndoSnapshot(preSnapshot);
        persist();
      }
    }

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList.contains('seat') || e.target.closest('.seat')) return;
      if (e.target.classList.contains('venue-delete')) return;
      if (e.target.classList.contains('resize-handle')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      moved = false;
      preSnapshot = JSON.stringify(state);
      startX = e.clientX;
      startY = e.clientY;
      origX = model.x;
      origY = model.y;
      node.classList.add('dragging');
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    });
  }

  /* ===================== Table popover ===================== */

  const popover = document.getElementById('tablePopover');

  function openPopover(table, node) {
    selectedTableId = table.id;
    document.getElementById('tableNameInput').value = table.name;
    document.getElementById('seatsValue').value = table.seats;
    popover.querySelectorAll('.shape-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.shape === (table.shape === 'round' ? 'round' : 'rect'));
    });
    popover.classList.add('open');
    positionPopover(node);
    renderFloor();
  }

  function positionPopover(node) {
    const rect = node.getBoundingClientRect();
    const pw = 240;
    let left = rect.right + 12;
    if (left + pw > window.innerWidth - 10) left = rect.left - pw - 12;
    popover.style.left = Math.max(10, left) + 'px';
    popover.style.top = Math.max(10, rect.top) + 'px';
  }

  function closePopover() {
    selectedTableId = null;
    popover.classList.remove('open');
  }

  document.getElementById('tableNameInput').addEventListener('input', (e) => {
    const t = findTable(selectedTableId);
    if (!t) return;
    t.name = e.target.value || t.name;
    persist();
    renderFloor();
  });

  document.getElementById('tableDeleteBtn').addEventListener('click', () => {
    if (!selectedTableId) return;
    pushUndo();
    state.tables = state.tables.filter(t => t.id !== selectedTableId);
    closePopover();
    render();
  });

  popover.querySelectorAll('.shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = findTable(selectedTableId);
      if (!t) return;
      pushUndo();
      t.shape = btn.dataset.shape === 'round' ? 'round' : 'rect';
      popover.querySelectorAll('.shape-btn').forEach(b => b.classList.toggle('active', b === btn));
      render();
      const node = floorEl.querySelector(`[data-table-id="${t.id}"]`);
      if (node) positionPopover(node);
    });
  });

  function applySeatCount(t, next) {
    next = Math.max(1, Math.min(40, next));
    if (next === t.seats) { document.getElementById('seatsValue').value = t.seats; return; }
    pushUndo();
    if (next < t.seats) {
      t.seatAssignments = t.seatAssignments.slice(0, next);
    } else {
      while (t.seatAssignments.length < next) t.seatAssignments.push(null);
    }
    t.seats = next;
    document.getElementById('seatsValue').value = t.seats;
    render();
    const node = floorEl.querySelector(`[data-table-id="${t.id}"]`);
    if (node) positionPopover(node);
  }

  document.getElementById('seatsMinus').addEventListener('click', () => {
    const t = findTable(selectedTableId);
    if (t) applySeatCount(t, t.seats - 1);
  });
  document.getElementById('seatsPlus').addEventListener('click', () => {
    const t = findTable(selectedTableId);
    if (t) applySeatCount(t, t.seats + 1);
  });
  document.getElementById('seatsValue').addEventListener('change', (e) => {
    const t = findTable(selectedTableId);
    if (!t) return;
    let next = parseInt(e.target.value, 10);
    if (isNaN(next)) next = t.seats;
    applySeatCount(t, next);
  });

  document.addEventListener('click', (e) => {
    if (popover.classList.contains('open') && !popover.contains(e.target) && !e.target.closest('.table-node')) {
      closePopover();
      renderFloor();
    }
  });

  /* ===================== Venue element popover ===================== */

  const elementPopover = document.getElementById('elementPopover');

  function openElementPopover(el, node) {
    selectedElementId = el.id;
    document.getElementById('elementNameInput').value = el.label;
    document.getElementById('elementColorInput').value = el.color || DEFAULT_ELEMENT_COLOR;
    elementPopover.querySelectorAll('.shape-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.elShape === (el.shape === 'oval' ? 'oval' : 'rect'));
    });
    elementPopover.classList.add('open');
    positionElementPopover(node);
    renderFloor();
  }

  function positionElementPopover(node) {
    const rect = node.getBoundingClientRect();
    const pw = 240;
    let left = rect.right + 12;
    if (left + pw > window.innerWidth - 10) left = rect.left - pw - 12;
    elementPopover.style.left = Math.max(10, left) + 'px';
    elementPopover.style.top = Math.max(10, rect.top) + 'px';
  }

  function closeElementPopover() {
    selectedElementId = null;
    elementPopover.classList.remove('open');
  }

  document.getElementById('elementNameInput').addEventListener('input', (e) => {
    const el = findElement(selectedElementId);
    if (!el) return;
    el.label = e.target.value || el.label;
    persist();
    renderFloor();
  });

  document.getElementById('elementColorInput').addEventListener('input', (e) => {
    const el = findElement(selectedElementId);
    if (!el) return;
    el.color = e.target.value;
    persist();
    renderFloor();
  });

  document.getElementById('elementDeleteBtn').addEventListener('click', () => {
    if (!selectedElementId) return;
    pushUndo();
    state.elements = state.elements.filter(x => x.id !== selectedElementId);
    closeElementPopover();
    render();
  });

  elementPopover.querySelectorAll('.shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = findElement(selectedElementId);
      if (!el) return;
      el.shape = btn.dataset.elShape === 'oval' ? 'oval' : 'rect';
      elementPopover.querySelectorAll('.shape-btn').forEach(b => b.classList.toggle('active', b === btn));
      persist();
      renderFloor();
      const node = floorEl.querySelector(`[data-el-id="${el.id}"]`);
      if (node) positionElementPopover(node);
    });
  });

  document.addEventListener('click', (e) => {
    if (elementPopover.classList.contains('open') && !elementPopover.contains(e.target) && !e.target.closest('.venue-node')) {
      closeElementPopover();
      renderFloor();
    }
  });

  /* ===================== Add table / elements ===================== */

  document.getElementById('btnAddTable').addEventListener('click', () => {
    if (state.tables.length >= state.maxTables) {
      toast(`Table limit reached (${state.maxTables}). Raise it in Settings.`);
      return;
    }
    pushUndo();
    const table = {
      id: uid('table'),
      name: 'Table ' + (state.tables.length + 1),
      shape: 'round',
      seats: 6,
      x: 60 + (state.tables.length % 5) * 160,
      y: 60 + Math.floor(state.tables.length / 5) * 180,
      seatAssignments: new Array(6).fill(null)
    };
    state.tables.push(table);
    render();
  });

  document.querySelectorAll('.element-chip').forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/element-type', chip.dataset.elType);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });

  const ELEMENT_DEFS = {
    stage: { label: 'Stage', w: 180, h: 80, icon: '🎤' },
    dance: { label: 'Dance Floor', w: 160, h: 160, icon: '💃' },
    bar: { label: 'Bar', w: 140, h: 60, icon: '🍸' },
    entrance: { label: 'Entrance', w: 120, h: 50, icon: '🚪' }
  };

  floorEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/element-type')) e.preventDefault();
  });
  floorEl.addEventListener('drop', (e) => {
    const type = e.dataTransfer.getData('text/element-type');
    if (!type) return;
    e.preventDefault();
    const def = ELEMENT_DEFS[type];
    const rect = floorEl.getBoundingClientRect();
    const maxX = state.venueWidth / zoom;
    const maxY = state.venueHeight / zoom;
    const x = Math.min(maxX, Math.max(0, (e.clientX - rect.left) / zoom - def.w / 2));
    const y = Math.min(maxY, Math.max(0, (e.clientY - rect.top) / zoom - def.h / 2));
    pushUndo();
    state.elements.push({
      id: uid('el'), type, label: def.label, shape: 'rect', color: DEFAULT_ELEMENT_COLOR,
      x, y, w: def.w, h: def.h
    });
    render();
  });

  /* ===================== Guests ===================== */

  document.getElementById('addGuestForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('guestNameInput');
    const mealInput = document.getElementById('guestMealInput');
    const name = nameInput.value.trim();
    if (!name) return;
    pushUndo();
    state.guests.push({ id: uid('guest'), name, meal: mealInput.value.trim(), groupId: null });
    nameInput.value = '';
    mealInput.value = '';
    render();
  });

  document.getElementById('guestSearch').addEventListener('input', renderGuestLists);

  const unassignedListEl = document.getElementById('unassignedList');
  unassignedListEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    unassignedListEl.setAttribute('data-drop-active', 'true');
  });
  unassignedListEl.addEventListener('dragleave', () => unassignedListEl.removeAttribute('data-drop-active'));
  unassignedListEl.addEventListener('drop', (e) => {
    e.preventDefault();
    unassignedListEl.removeAttribute('data-drop-active');
    const guestId = e.dataTransfer.getData('text/guest-id');
    if (!guestId) return;
    pushUndo();
    unassignGuest(guestId);
    render();
  });

  /* ===================== CSV import ===================== */

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); field = ''; rows.push(row); row = [];
      } else if (c === '\r') {
        // ignore, \n follows
      } else {
        field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }

  document.getElementById('csvImportInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCSV(String(reader.result));
        if (!rows.length) { toast('That CSV looks empty'); return; }

        let header = rows[0].map(h => h.trim().toLowerCase());
        let dataRows = rows.slice(1);
        let nameIdx = header.indexOf('name');
        let householdIdx = header.findIndex(h => h.includes('household') || h.includes('group'));
        let mealIdx = header.findIndex(h => h.includes('meal') || h.includes('dietary'));

        if (nameIdx === -1) {
          dataRows = rows;
          nameIdx = 0; householdIdx = -1; mealIdx = -1;
        }

        pushUndo();
        const householdMap = {};
        let added = 0;
        dataRows.forEach(cols => {
          const name = (cols[nameIdx] || '').trim();
          if (!name) return;
          const meal = mealIdx >= 0 ? (cols[mealIdx] || '').trim() : '';
          const household = householdIdx >= 0 ? (cols[householdIdx] || '').trim() : '';
          const guest = { id: uid('guest'), name, meal, groupId: null };
          state.guests.push(guest);
          added++;
          if (household) (householdMap[household] = householdMap[household] || []).push(guest);
        });

        Object.entries(householdMap).forEach(([householdName, guestsInHousehold]) => {
          if (guestsInHousehold.length > 1) {
            const group = { id: uid('group'), name: householdName, guestIds: guestsInHousehold.map(g => g.id) };
            state.groups.push(group);
            guestsInHousehold.forEach(g => { g.groupId = group.id; });
          }
        });

        render();
        toast(`Imported ${added} guest${added === 1 ? '' : 's'} from CSV`);
      } catch (err) {
        toast('Could not parse that CSV file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* ===================== Event name & settings ===================== */

  document.getElementById('eventName').addEventListener('input', (e) => {
    state.eventName = e.target.value;
    persist();
  });

  document.getElementById('eventSubtitle').addEventListener('input', (e) => {
    state.eventSubtitle = e.target.value;
    persist();
  });

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.modal-backdrop').classList.remove('open'));
  });
  document.querySelectorAll('.modal-backdrop').forEach(mb => {
    mb.addEventListener('click', (e) => { if (e.target === mb) mb.classList.remove('open'); });
  });

  document.getElementById('btnSettings').addEventListener('click', () => openModal('settingsModal'));

  document.getElementById('settingsApplyBtn').addEventListener('click', () => {
    pushUndo();
    state.maxTables = Math.max(1, parseInt(document.getElementById('maxTablesInput').value, 10) || 1);
    state.venueWidth = Math.max(600, parseInt(document.getElementById('venueWidthInput').value, 10) || 1600);
    state.venueHeight = Math.max(400, parseInt(document.getElementById('venueHeightInput').value, 10) || 1000);
    closeModal('settingsModal');
    render();
  });

  /* ===================== Save / Load ===================== */

  document.getElementById('btnSaveLoad').addEventListener('click', () => {
    renderSavesList();
    openModal('saveLoadModal');
  });

  document.getElementById('saveAsBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('saveNameInput');
    const name = nameInput.value.trim() || state.eventName || 'Untitled arrangement';
    const saves = getSaves();
    const existingIdx = saves.findIndex(s => s.name === name);
    const entry = { id: existingIdx >= 0 ? saves[existingIdx].id : uid('save'), name, updatedAt: Date.now(), data: state };
    if (existingIdx >= 0) saves[existingIdx] = entry; else saves.push(entry);
    setSaves(saves);
    nameInput.value = '';
    renderSavesList();
    toast('Saved “' + name + '”');
  });

  function renderSavesList() {
    const list = document.getElementById('savesList');
    const saves = getSaves().sort((a, b) => b.updatedAt - a.updatedAt);
    list.innerHTML = '';
    document.getElementById('savesEmptyHint').style.display = saves.length ? 'none' : 'block';

    saves.forEach(save => {
      const li = document.createElement('li');
      li.className = 'save-item';

      const info = document.createElement('div');
      info.className = 'save-item-info';
      const name = document.createElement('div');
      name.className = 'save-item-name';
      name.textContent = save.name;
      const meta = document.createElement('div');
      meta.className = 'save-item-meta';
      meta.textContent = new Date(save.updatedAt).toLocaleString();
      info.appendChild(name);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'save-item-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn btn-secondary btn-sm';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => {
        pushUndo();
        state = normalizeState(JSON.parse(JSON.stringify(save.data)));
        closeModal('saveLoadModal');
        selectedTableId = null;
        render();
        toast('Loaded “' + save.name + '”');
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn danger';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete save';
      delBtn.addEventListener('click', () => {
        setSaves(getSaves().filter(s => s.id !== save.id));
        renderSavesList();
      });

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      li.appendChild(info);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  /* ===================== Groups (households / plus-ones) ===================== */

  function renderGuestChecklist(container) {
    container.innerHTML = '';
    if (!state.guests.length) {
      container.innerHTML = '<p class="hint" style="margin:2px;">Add guests first.</p>';
      return;
    }
    state.guests.forEach(g => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = g.id;
      label.appendChild(cb);
      const span = document.createElement('span');
      const groupName = g.groupId ? (findGroup(g.groupId) || {}).name : null;
      span.textContent = g.name + (groupName ? ` (${groupName})` : '');
      label.appendChild(span);
      container.appendChild(label);
    });
  }

  document.getElementById('btnGroups').addEventListener('click', () => {
    renderGuestChecklist(document.getElementById('groupGuestChecklist'));
    renderGroupsList();
    openModal('groupsModal');
  });

  document.getElementById('createGroupBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('groupNameInput');
    const name = nameInput.value.trim();
    const checked = Array.from(document.querySelectorAll('#groupGuestChecklist input:checked')).map(cb => cb.value);
    if (checked.length < 2) { toast('Select at least 2 guests to link into a group'); return; }
    if (!name) { toast('Give the group a name'); return; }

    pushUndo();
    checked.forEach(id => {
      const g = findGuest(id);
      if (g && g.groupId) {
        const oldGroup = findGroup(g.groupId);
        if (oldGroup) oldGroup.guestIds = oldGroup.guestIds.filter(x => x !== id);
        g.groupId = null;
      }
    });
    state.groups = state.groups.filter(gr => gr.guestIds.length > 1);

    const group = { id: uid('group'), name, guestIds: checked.slice() };
    state.groups.push(group);
    checked.forEach(id => { const g = findGuest(id); if (g) g.groupId = group.id; });

    nameInput.value = '';
    renderGuestChecklist(document.getElementById('groupGuestChecklist'));
    renderGroupsList();
    render();
    toast(`Created group "${name}"`);
  });

  function renderGroupsList() {
    const list = document.getElementById('groupsList');
    list.innerHTML = '';
    document.getElementById('groupsEmptyHint').style.display = state.groups.length ? 'none' : 'block';

    state.groups.forEach(group => {
      const li = document.createElement('li');
      li.className = 'entity-item';

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'entity-item-title';
      title.textContent = group.name;
      const members = document.createElement('div');
      members.className = 'entity-item-members';
      members.textContent = group.guestIds.map(id => (findGuest(id) || {}).name).filter(Boolean).join(', ');
      info.appendChild(title);
      info.appendChild(members);

      const del = document.createElement('button');
      del.className = 'icon-btn danger';
      del.textContent = '✕';
      del.title = 'Delete group';
      del.addEventListener('click', () => {
        pushUndo();
        group.guestIds.forEach(id => { const g = findGuest(id); if (g && g.groupId === group.id) g.groupId = null; });
        state.groups = state.groups.filter(gr => gr.id !== group.id);
        renderGuestChecklist(document.getElementById('groupGuestChecklist'));
        renderGroupsList();
        render();
      });

      li.appendChild(info);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  /* ===================== Seating rules & violations UI ===================== */

  document.querySelectorAll('#rulesModal .shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedRuleType = btn.dataset.ruleType;
      document.querySelectorAll('#rulesModal .shape-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  function openRulesModal() {
    renderGuestChecklist(document.getElementById('ruleGuestChecklist'));
    renderRulesList();
    renderViolationsList();
    openModal('rulesModal');
  }

  document.getElementById('btnRules').addEventListener('click', openRulesModal);

  document.getElementById('createRuleBtn').addEventListener('click', () => {
    const checked = Array.from(document.querySelectorAll('#ruleGuestChecklist input:checked')).map(cb => cb.value);
    if (checked.length < 2) { toast('Select at least 2 guests for this rule'); return; }
    pushUndo();
    state.rules.push({ id: uid('rule'), type: selectedRuleType, guestIds: checked.slice() });
    renderGuestChecklist(document.getElementById('ruleGuestChecklist'));
    renderRulesList();
    renderViolationsList();
    render();
    toast('Rule added');
  });

  function renderRulesList() {
    const list = document.getElementById('rulesList');
    list.innerHTML = '';
    document.getElementById('rulesEmptyHint').style.display = state.rules.length ? 'none' : 'block';

    state.rules.forEach(rule => {
      const li = document.createElement('li');
      li.className = 'entity-item';

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'entity-item-title type-' + rule.type;
      title.textContent = rule.type === 'together' ? 'Must sit together' : 'Keep apart';
      const members = document.createElement('div');
      members.className = 'entity-item-members';
      members.textContent = rule.guestIds.map(id => (findGuest(id) || {}).name).filter(Boolean).join(', ');
      info.appendChild(title);
      info.appendChild(members);

      const del = document.createElement('button');
      del.className = 'icon-btn danger';
      del.textContent = '✕';
      del.title = 'Delete rule';
      del.addEventListener('click', () => {
        pushUndo();
        state.rules = state.rules.filter(r => r.id !== rule.id);
        renderRulesList();
        renderViolationsList();
        render();
      });

      li.appendChild(info);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function renderViolationsList() {
    const list = document.getElementById('violationList');
    const violations = computeViolations();
    list.innerHTML = '';
    violations.forEach(v => {
      const li = document.createElement('li');
      li.className = 'violation-item';
      li.textContent = '⚠ ' + v.message;
      list.appendChild(li);
    });
  }

  /* ===================== Auto-arrange ===================== */

  function unionFind(ids) {
    const parent = {};
    ids.forEach(id => { parent[id] = id; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    return { find, union };
  }

  function computeClusters() {
    const allGuestIds = state.guests.map(g => g.id);
    const uf = unionFind(allGuestIds);
    state.groups.forEach(g => {
      for (let i = 1; i < g.guestIds.length; i++) uf.union(g.guestIds[0], g.guestIds[i]);
    });
    state.rules.filter(r => r.type === 'together').forEach(r => {
      for (let i = 1; i < r.guestIds.length; i++) uf.union(r.guestIds[0], r.guestIds[i]);
    });
    const clusters = {};
    allGuestIds.forEach(id => {
      const root = uf.find(id);
      (clusters[root] = clusters[root] || []).push(id);
    });
    return Object.values(clusters);
  }

  function apartConflictMap() {
    const avoid = {};
    state.rules.filter(r => r.type === 'apart').forEach(r => {
      r.guestIds.forEach(a => {
        r.guestIds.forEach(b => {
          if (a === b) return;
          (avoid[a] = avoid[a] || new Set()).add(b);
        });
      });
    });
    return avoid;
  }

  function autoArrange() {
    const clusters = computeClusters();
    const avoid = apartConflictMap();
    const unassignedIds = new Set(unassignedGuests().map(g => g.id));
    let placedCount = 0;
    const unplaced = [];

    const orderedClusters = clusters
      .map(ids => ids.filter(id => unassignedIds.has(id)))
      .filter(ids => ids.length)
      .sort((a, b) => b.length - a.length);

    orderedClusters.forEach(clusterIds => {
      const internalConflict = clusterIds.some(id =>
        clusterIds.some(otherId => otherId !== id && avoid[id] && avoid[id].has(otherId))
      );

      let placedHere = false;
      if (!internalConflict) {
        const anchorInfo = clusterIds.map(guestTableInfo).find(Boolean);
        const candidateTables = anchorInfo
          ? [anchorInfo.table, ...state.tables.filter(t => t.id !== anchorInfo.table.id)]
          : state.tables.slice();

        for (const table of candidateTables) {
          const emptySeatIdx = [];
          table.seatAssignments.forEach((gid, idx) => { if (!gid) emptySeatIdx.push(idx); });
          if (emptySeatIdx.length < clusterIds.length) continue;

          const alreadyThere = table.seatAssignments.filter(Boolean);
          const conflict = clusterIds.some(id =>
            alreadyThere.some(otherId => avoid[id] && avoid[id].has(otherId))
          );
          if (conflict) continue;

          clusterIds.forEach((id, idx) => seatGuest(id, table, emptySeatIdx[idx]));
          placedCount += clusterIds.length;
          placedHere = true;
          break;
        }
      }

      if (!placedHere) {
        clusterIds.forEach(id => { const g = findGuest(id); if (g) unplaced.push(g.name); });
      }
    });

    render();
    return { placedCount, unplaced };
  }

  document.getElementById('btnAutoArrange').addEventListener('click', () => {
    const before = unassignedGuests().length;
    if (!before) { toast('Everyone is already seated'); return; }

    pushUndo();
    const { placedCount, unplaced } = autoArrange();
    const body = document.getElementById('autoArrangeBody');
    body.innerHTML = '';

    const summary = document.createElement('div');
    summary.className = 'aa-summary';
    summary.textContent = `Seated ${placedCount} of ${before} unassigned guest${before === 1 ? '' : 's'}.`;
    body.appendChild(summary);

    if (unplaced.length) {
      const box = document.createElement('div');
      box.className = 'aa-unplaced';
      const title = document.createElement('div');
      title.textContent = `Could not place ${unplaced.length} guest${unplaced.length === 1 ? '' : 's'} (no table had enough matching open seats, or a rule conflict):`;
      box.appendChild(title);
      const ul = document.createElement('ul');
      ul.style.margin = '6px 0 0';
      ul.style.paddingLeft = '18px';
      unplaced.forEach(name => {
        const li = document.createElement('li');
        li.className = 'aa-unplaced-name';
        li.textContent = name;
        ul.appendChild(li);
      });
      box.appendChild(ul);
      body.appendChild(box);
    }

    openModal('autoArrangeModal');
  });

  /* ===================== Share ===================== */

  document.getElementById('btnShare').addEventListener('click', () => {
    const json = JSON.stringify(state);
    const encoded = btoa(unescape(encodeURIComponent(json)));
    const url = location.origin + location.pathname + '#d=' + encoded;
    document.getElementById('shareLinkInput').value = url;
    openModal('shareModal');
  });

  document.getElementById('copyLinkBtn').addEventListener('click', async () => {
    const input = document.getElementById('shareLinkInput');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Link copied to clipboard');
    } catch (e) {
      document.execCommand('copy');
      toast('Link copied to clipboard');
    }
  });

  document.getElementById('exportJsonBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.eventName || 'seating-arrangement').replace(/[^\w\-]+/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('importJsonInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        pushUndo();
        state = normalizeState(JSON.parse(reader.result));
        selectedTableId = null;
        closeModal('shareModal');
        render();
        toast('Arrangement imported');
      } catch (err) {
        toast('Could not read that file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('exportCateringBtn').addEventListener('click', () => {
    const rows = [['Name', 'Table', 'Seat #', 'Meal / Dietary', 'Group']];
    state.guests.forEach(g => {
      const info = guestTableInfo(g.id);
      const group = g.groupId ? ((findGroup(g.groupId) || {}).name || '') : '';
      rows.push([
        g.name,
        info ? info.table.name : 'Unassigned',
        info ? String(info.seatIndex + 1) : '',
        g.meal || '',
        group
      ]);
    });
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.eventName || 'seating').replace(/[^\w\-]+/g, '_') + '_catering.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  function loadFromHash() {
    const m = location.hash.match(/#d=(.+)/);
    if (!m) return false;
    try {
      const json = decodeURIComponent(escape(atob(m[1])));
      state = normalizeState(JSON.parse(json));
      history.replaceState(null, '', location.pathname);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ===================== Print / PDF export ===================== */

  function buildPrintArea() {
    const area = document.getElementById('printArea');
    area.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'print-header';
    const h1 = document.createElement('h1');
    h1.textContent = state.eventName || 'Seating Plan';
    header.appendChild(h1);
    if (state.eventSubtitle) {
      const sub = document.createElement('p');
      sub.className = 'print-subtitle';
      sub.textContent = state.eventSubtitle;
      header.appendChild(sub);
    }
    const p = document.createElement('p');
    p.textContent = `${state.tables.length} tables · ${state.guests.length} guests · generated ${new Date().toLocaleDateString()}`;
    header.appendChild(p);
    area.appendChild(header);

    state.tables.forEach(table => {
      const card = document.createElement('div');
      card.className = 'print-table';
      const h2 = document.createElement('h2');
      const occupied = table.seatAssignments.filter(Boolean).length;
      h2.textContent = `${table.name} (${occupied}/${table.seats} seated)`;
      card.appendChild(h2);

      const ol = document.createElement('ol');
      table.seatAssignments.forEach(gid => {
        if (!gid) return;
        const g = findGuest(gid);
        if (!g) return;
        const li = document.createElement('li');
        li.textContent = g.name + (g.meal ? ` — ${g.meal}` : '');
        ol.appendChild(li);
      });
      card.appendChild(ol);

      const emptyCount = table.seats - occupied;
      if (emptyCount > 0) {
        const note = document.createElement('div');
        note.className = 'print-empty-seats';
        note.textContent = `${emptyCount} open seat${emptyCount === 1 ? '' : 's'}`;
        card.appendChild(note);
      }
      area.appendChild(card);
    });

    const unassigned = unassignedGuests();
    if (unassigned.length) {
      const card = document.createElement('div');
      card.className = 'print-unassigned';
      const h2 = document.createElement('h2');
      h2.textContent = `Unassigned (${unassigned.length})`;
      card.appendChild(h2);
      const ol = document.createElement('ol');
      unassigned.forEach(g => {
        const li = document.createElement('li');
        li.textContent = g.name + (g.meal ? ` — ${g.meal}` : '');
        ol.appendChild(li);
      });
      card.appendChild(ol);
      area.appendChild(card);
    }
  }

  document.getElementById('btnPrint').addEventListener('click', () => {
    buildPrintArea();
    window.print();
  });

  /* ===================== Zoom ===================== */

  function applyZoom() {
    floorEl.style.width = (state.venueWidth / zoom) + 'px';
    floorEl.style.height = (state.venueHeight / zoom) + 'px';
    stageEl.style.transform = `scale(${zoom})`;
    document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  }
  document.getElementById('btnZoomIn').addEventListener('click', () => { zoom = Math.min(2, zoom + 0.1); applyZoom(); });
  document.getElementById('btnZoomOut').addEventListener('click', () => { zoom = Math.max(0.4, zoom - 0.1); applyZoom(); });
  document.getElementById('btnZoomReset').addEventListener('click', () => { zoom = 1; applyZoom(); });

  /* ===================== Init ===================== */

  loadFromHash();
  updateUndoButton();
  render();
})();

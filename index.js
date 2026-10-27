// Smart Chat Search
// Buscador estilo WhatsApp para SillyTavern:
//  - busca en TODO el historial del chat (aunque no este cargado en pantalla)
//  - ignora mayusculas y acentos (buscar "arbol" encuentra "árbol")
//  - resalta todas las coincidencias y marca la actual con otro color
//  - flechas para ir a la coincidencia anterior / siguiente + contador "3 de 27"

(function () {
    'use strict';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const getCtx = () => SillyTavern.getContext();

    // Pasa a minusculas y quita acentos, conservando la longitud 1 a 1
    // para poder mapear posiciones al texto original.
    function fold(s) {
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            const d = c.normalize('NFD')[0] || c;
            out += (d.toLowerCase()[0]) || d;
        }
        return out;
    }

    const state = {
        query: '',
        fq: '',
        hits: [], // [{ id, count }] en orden cronologico
        total: 0,
        pos: 0, // 1..total
        token: 0,
    };

    let bar, input, countEl, prevBtn, nextBtn;
    let debounceTimer = null;

    function chatEl() {
        return document.getElementById('chat');
    }

    // ---------- Busqueda ----------

    function runSearch(q) {
        state.query = q;
        state.fq = fold(q);
        state.hits = [];
        state.total = 0;
        state.pos = 0;

        if (!state.fq) {
            highlightAll();
            updateCount();
            return;
        }

        const chat = getCtx().chat || [];
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m || typeof m.mes !== 'string') continue;
            const t = fold(m.mes);
            let n = 0;
            let p = t.indexOf(state.fq);
            while (p !== -1) {
                n++;
                p = t.indexOf(state.fq, p + state.fq.length);
            }
            if (n) {
                state.hits.push({ id: i, count: n });
                state.total += n;
            }
        }

        if (state.total > 0) {
            goTo(state.total); // empieza por la mas reciente, como WhatsApp
        } else {
            highlightAll();
            updateCount();
        }
    }

    // ---------- Resaltado ----------

    function clearMarks(root) {
        root.querySelectorAll('mark.scs-hl').forEach((m) => {
            const parent = m.parentNode;
            if (!parent) return;
            parent.replaceChild(document.createTextNode(m.textContent), m);
            parent.normalize();
        });
    }

    function highlightNode(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                const p = n.parentElement;
                if (!p || p.closest('script,style,mark.scs-hl')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        const fq = state.fq;
        for (const node of nodes) {
            const text = node.nodeValue;
            const t = fold(text);
            let pos = t.indexOf(fq);
            if (pos === -1) continue;

            const frag = document.createDocumentFragment();
            let last = 0;
            while (pos !== -1) {
                if (pos > last) frag.append(text.slice(last, pos));
                const mark = document.createElement('mark');
                mark.className = 'scs-hl';
                mark.textContent = text.slice(pos, pos + fq.length);
                frag.append(mark);
                last = pos + fq.length;
                pos = t.indexOf(fq, last);
            }
            if (last < text.length) frag.append(text.slice(last));
            node.replaceWith(frag);
        }
    }

    function highlightAll() {
        const root = chatEl();
        if (!root) return;
        clearMarks(root);
        if (!state.fq) return;
        root.querySelectorAll('.mes_text').forEach(highlightNode);
    }

    // ---------- Cargar mensajes viejos ----------

    function mesNode(id) {
        return document.querySelector(`#chat .mes[mesid="${id}"]`);
    }

    function firstRenderedId() {
        let min = Infinity;
        document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
            const v = Number(el.getAttribute('mesid'));
            if (!Number.isNaN(v) && v < min) min = v;
        });
        return min;
    }

    async function ensureRendered(id) {
        if (mesNode(id)) return true;

        // Intento 1: funcion interna de SillyTavern (carga varios de golpe)
        try {
            const mod = await import('/script.js');
            if (typeof mod.showMoreMessages === 'function') {
                const first = firstRenderedId();
                if (Number.isFinite(first) && first > id) {
                    await mod.showMoreMessages(first - id + 5);
                    await sleep(50);
                    if (mesNode(id)) return true;
                }
            }
        } catch (e) {
            console.debug('[SmartChatSearch] showMoreMessages no disponible, uso el boton', e);
        }

        // Intento 2: pulsar "Mostrar mas mensajes" hasta que aparezca
        for (let i = 0; i < 300; i++) {
            if (mesNode(id)) return true;
            const btn = document.getElementById('show_more_messages');
            if (!btn) break;
            btn.click();
            await sleep(40);
        }
        return !!mesNode(id);
    }

    // ---------- Navegacion ----------

    function locate(pos) {
        let acc = 0;
        for (const h of state.hits) {
            if (pos <= acc + h.count) return { id: h.id, k: pos - acc - 1 };
            acc += h.count;
        }
        return null;
    }

    async function goTo(pos) {
        if (!state.total) return;
        const token = ++state.token;
        state.pos = pos;
        updateCount();

        const loc = locate(pos);
        if (!loc) return;

        const ok = await ensureRendered(loc.id);
        if (token !== state.token) return; // llegó otra orden más nueva
        if (!ok) return;

        highlightAll();

        const msg = mesNode(loc.id);
        if (!msg) return;

        const marks = msg.querySelectorAll('mark.scs-hl');
        document.querySelectorAll('mark.scs-current').forEach((m) => m.classList.remove('scs-current'));

        const target = marks.length ? marks[Math.min(loc.k, marks.length - 1)] : msg;
        if (marks.length) target.classList.add('scs-current');
        target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }

    function goPrev() {
        if (!state.total) return;
        goTo(state.pos <= 1 ? state.total : state.pos - 1);
    }

    function goNext() {
        if (!state.total) return;
        goTo(state.pos >= state.total ? 1 : state.pos + 1);
    }

    // ---------- UI ----------

    function updateCount() {
        if (!countEl) return;
        if (!state.fq) {
            countEl.textContent = '';
        } else if (!state.total) {
            countEl.textContent = 'Sin resultados';
        } else {
            countEl.textContent = `${state.pos} de ${state.total}`;
        }
        const off = !state.total;
        prevBtn.classList.toggle('scs-disabled', off);
        nextBtn.classList.toggle('scs-disabled', off);
    }

    function openBar(initial) {
        bar.classList.add('scs-open');
        if (typeof initial === 'string' && initial !== input.value) {
            input.value = initial;
            runSearch(initial);
        }
        setTimeout(() => {
            input.focus();
            input.select();
        }, 30);
    }

    function closeBar() {
        state.token++;
        bar.classList.remove('scs-open');
        input.value = '';
        input.blur();
        state.query = '';
        state.fq = '';
        state.hits = [];
        state.total = 0;
        state.pos = 0;
        const root = chatEl();
        if (root) clearMarks(root);
        updateCount();
    }

    function buildBar() {
        bar = document.createElement('div');
        bar.id = 'scs_bar';
        bar.innerHTML = `
            <div id="scs_close" class="scs-btn fa-solid fa-arrow-left" title="Cerrar"></div>
            <input id="scs_input" type="search" enterkeyhint="search" autocomplete="off"
                   autocapitalize="off" spellcheck="false" placeholder="Buscar en el chat...">
            <span id="scs_count"></span>
            <div id="scs_prev" class="scs-btn fa-solid fa-chevron-up" title="Anterior (más antigua)"></div>
            <div id="scs_next" class="scs-btn fa-solid fa-chevron-down" title="Siguiente (más reciente)"></div>
        `;
        document.body.appendChild(bar);

        input = bar.querySelector('#scs_input');
        countEl = bar.querySelector('#scs_count');
        prevBtn = bar.querySelector('#scs_prev');
        nextBtn = bar.querySelector('#scs_next');

        bar.querySelector('#scs_close').addEventListener('click', closeBar);
        prevBtn.addEventListener('click', goPrev);
        nextBtn.addEventListener('click', goNext);

        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => runSearch(input.value), 250);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(debounceTimer);
                if (input.value !== state.query) runSearch(input.value);
                else if (e.shiftKey) goNext();
                else goPrev();
            } else if (e.key === 'Escape') {
                closeBar();
            }
        });

        updateCount();
    }

    // Boton en el menu de la varita (extensiones)
    function addMenuButton() {
        const tryAdd = () => {
            const menu = document.getElementById('extensionsMenu');
            if (!menu) return false;
            if (document.getElementById('scs_menu_btn')) return true;
            const item = document.createElement('div');
            item.id = 'scs_menu_btn';
            item.className = 'list-group-item flex-container flexGap5';
            item.innerHTML =
                '<div class="fa-solid fa-magnifying-glass extensionsMenuExtensionButton"></div><span>Buscar en el chat</span>';
            item.addEventListener('click', () => openBar());
            menu.appendChild(item);
            return true;
        };
        if (tryAdd()) return;
        const obs = new MutationObserver(() => {
            if (tryAdd()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // Engancha el campo de busqueda de la extension TopInfoBar:
    // al tocarlo, abre esta barra en lugar de usar el campo chiquito.
    function hookTopInfoBar() {
        const SELECTOR =
            '[id*="top" i][id*="bar" i], [id*="topinfo" i], [id*="top-info" i], [class*="top-info" i], [class*="topinfo" i]';
        document.addEventListener('focusin', (e) => {
            const t = e.target;
            if (!(t instanceof HTMLInputElement)) return;
            if (t.closest('#scs_bar')) return;
            if (!t.closest(SELECTOR)) return;
            if (!/^(search|buscar|sea)/i.test(t.placeholder || '')) return;
            const initial = t.value || '';
            t.blur();
            openBar(initial);
        });
    }

    jQuery(() => {
        buildBar();
        addMenuButton();
        hookTopInfoBar();

        try {
            const { eventSource, event_types } = getCtx();
            eventSource.on(event_types.CHAT_CHANGED, closeBar);
        } catch (e) {
            console.warn('[SmartChatSearch] no pude escuchar CHAT_CHANGED', e);
        }

        console.log('[SmartChatSearch] cargada');
    });
})();

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Html, Text } from '@react-three/drei';
import * as THREE from 'three';
import { useKnowledgeStore } from '../../store/knowledgeStore.js';
import { damp, floatingOffset } from '../../utils/animations.js';
import { COLORS, FONT } from '../../utils/palette.js';
import { hasLanded, sceneState } from '../../utils/sceneLayout.js';
import { WIRE_SEGMENTS, WIRE_TIME, drawPanelWire, makeBoard } from '../../utils/panelWire.js';
import '../../styles/holo.css';

// The screen is a page laid out in CSS pixels, each this many world units:
// its 14px body text then stands as tall as the scene's other small text.
const WORLD_PER_PX = 0.0105;
// Its parts, in its own CSS pixels (styles/holo.css): the body's top inset
// (where the rail starts too), the cut corners.
const BODY_TOP = 44;
const CUT = 18;
const POWER_TIME = 0.55; // the screen switching on, once the wire is in
const NAV_STEP = 0.85; // between the navigation buttons under the focus
const NAV_Y = -0.1; // their middle, below the row's top
const EDGE_FADE = 36; // px over which a block fades out at the body's edges
// Each block, once it is in view, gets a spark down the rail from the
// wire's port (SPARK_TIME, one after another STAGGER apart); when it arrives
// the block types itself out, at least TYPE_RATE characters a second and
// done within TYPE_MAX seconds, then a white line sweeps down it.
const SPARK_TIME = 0.4;
const STAGGER = 0.14;
const TYPE_RATE = 140;
const TYPE_MAX = 1.1;
// Until the user scrolls it themselves the screen scrolls itself: slowly
// down, a pause at the end, back up at a watchable pace, and down again.
const AUTO_DELAY = 1.5; // before it starts, and after each return to the top
const AUTO_SPEED = 26; // px a second
const AUTO_HOLD = 2; // at the end, before going back up
const AUTO_RETURN = 320; // px a second back up

// The preview page: the example as-is on a plain white page (browser
// defaults, so <h1> really is 2em), plus a tiny script that reports its
// height and forwards the mouse wheel, since the sandboxed frame keeps both
// to itself.
function previewDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html{background:#fff;color:#000}</style></head><body>${html}
<script>
const post = (m) => parent.postMessage(Object.assign({ __preview: 1 }, m), '*');
const size = () => post({ h: document.documentElement.scrollHeight });
addEventListener('load', size);
new ResizeObserver(size).observe(document.documentElement);
addEventListener('wheel', (e) => post({ dy: e.deltaY }), { passive: true });
// Nothing leaves the frame: a submitted form shows the request it would
// send (after the browser's own validation), a link shows where it goes.
const note = (t) => {
  let n = document.getElementById('__note');
  if (!n) {
    n = document.createElement('div');
    n.id = '__note';
    n.style.cssText = 'margin-top:8px;padding:4px 6px;background:#fffbe6;border:1px solid #e0c200;font:12px monospace;white-space:pre-wrap';
    document.body.append(n);
  }
  n.textContent = t;
};
document.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target, b = e.submitter;
  const method = (b?.getAttribute('formmethod') || f.getAttribute('method') || 'get').toUpperCase();
  const action = b?.getAttribute('formaction') || f.getAttribute('action') || '(trang hiện tại)';
  const data = new URLSearchParams(new FormData(f, b)).toString();
  note('Gửi ' + method + ' ' + action + '\\n' + (data || '(không có dữ liệu)'));
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.getAttribute('href').startsWith('#')) return;
  e.preventDefault();
  note('Link tới: ' + a.getAttribute('href') + (a.target ? '  (target=' + a.target + ')' : ''));
});
</script></body></html>`;
}

// The node's content as screen blocks: its description, aliases, then its
// note blocks as they come (headings, text, code, live previews).
function buildBlocks(node) {
  const blocks = [];
  if (node.description) blocks.push({ kind: 'info', lines: [node.description] });
  if (node.aliases.length) blocks.push({ kind: 'alias', lines: [`Alias: ${node.aliases.join(', ')}`] });
  for (const b of node.blocks) {
    const lines = b.lines.map((l) => l.replace(/\t/g, '  '));
    if (b.type === 'heading') blocks.push({ kind: 'heading', lines: [lines.join(' ')] });
    else if (b.type === 'preview') blocks.push({ kind: 'preview', html: b.lines.join('\n'), lines: [] });
    else if (b.type === 'code') blocks.push({ kind: 'code', lines });
    else blocks.push({ kind: 'text', lines });
  }
  return blocks;
}

const pad2 = (n) => String(n).padStart(2, '0');
const bullet = (block, line) => block.kind === 'text' && line.startsWith('- ');

/**
 * The focused node's content: <<PREV / [ESC] / NEXT>> under the node, and a
 * holographic screen standing where the content column goes (a real page,
 * placed in the scene and always facing the camera, styles/holo.css),
 * wired to the focus by a little circuit board of traces (utils/panelWire.js). Its blocks scroll inside it — wheel or drag on
 * it, or the ↑ ↓ keys; until then it scrolls itself.
 */
export function FocusContent({ layout }) {
  const focus = useKnowledgeStore((s) => s.focus);
  if (!focus) return null;
  return <ContentScreen key={focus.node.id} focus={focus} layout={layout} colors={COLORS} font={FONT} />;
}

function ContentScreen({ focus, layout, colors, font }) {
  const { node } = focus;
  const box = layout.content;
  const canBack = useKnowledgeStore((s) => s.history.length > 0);
  const canForward = useKnowledgeStore((s) => s.future.length > 0);
  const { resetView, goBack, goForward, setContentHover } = useKnowledgeStore.getState();
  const blocks = useMemo(() => buildBlocks(node), [node]);
  // The circuit board wiring it in: a new one every time it opens.
  const board = useMemo(() => makeBoard(), []);

  const scale = WORLD_PER_PX;
  const widthPx = Math.round(box.w / scale);
  const heightPx = Math.round((box.top - box.bottom) / scale);

  const info = useRef();
  const wire = useRef();
  const wireBuf = useMemo(
    () => ({ positions: new Float32Array(WIRE_SEGMENTS * 6), colors: new Float32Array(WIRE_SEGMENTS * 6) }),
    []
  );
  // DOM parts of the screen, filled in by refs once it has rendered.
  const dom = useRef({ blocks: [], sparks: [], ports: [] });
  const [rootEl, setRootEl] = useState(null);
  // Animation state: when the wire started (once the focus has landed),
  // scrolling (px) and the self-scrolling, and each block's reveal.
  const st = useRef({
    wireAt: undefined,
    on: false,
    pos: 0,
    target: 0,
    auto: { on: true, wait: null, endAt: null, back: false },
    lastSpark: -Infinity,
    current: -1,
    blocks: blocks.map(() => ({ state: 'idle', t0: 0 })),
  });

  const maxScroll = () => {
    const { body, content } = dom.current;
    return body && content ? Math.max(0, content.offsetHeight - body.clientHeight) : 0;
  };
  const scrollTo = (px) => {
    st.current.auto.on = false;
    st.current.target = THREE.MathUtils.clamp(px, 0, maxScroll());
  };
  // A block up or down from the one being read.
  const step = (dir) => {
    const els = dom.current.blocks;
    const cur = Math.max(0, st.current.current);
    const next = els[THREE.MathUtils.clamp(cur + dir, 0, els.length - 1)];
    if (next) scrollTo(next.el.offsetTop - 10);
  };

  // Input on the screen: wheel, drag (mouse or touch) and, anywhere, the
  // ↑ ↓ keys. It owns the pointer while over it (contentHover), so the
  // camera leaves those to it.
  useEffect(() => {
    if (!rootEl) return undefined;
    let dragY = null;
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      scrollTo(st.current.target + e.deltaY * 0.6);
    };
    const onDown = (e) => {
      dragY = e.clientY;
      st.current.auto.on = false;
      rootEl.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (dragY === null) return;
      const k = Math.max(0.2, rootEl.getBoundingClientRect().height / heightPx);
      scrollTo(st.current.target - (e.clientY - dragY) / k);
      dragY = e.clientY;
    };
    const onUp = () => {
      dragY = null;
    };
    const onEnter = () => setContentHover(true);
    const onLeave = () => setContentHover(false);
    const onKey = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        step(-1);
      }
    };
    const onMessage = (e) => {
      if (!e.data?.__preview) return;
      const block = dom.current.blocks.find((b) => b?.frame && b.frame.contentWindow === e.source);
      if (!block) return;
      if (e.data.h) block.frame.style.height = `${Math.ceil(e.data.h)}px`;
      if (e.data.dy) scrollTo(st.current.target + e.data.dy * 0.6);
    };
    rootEl.addEventListener('wheel', onWheel, { passive: false });
    rootEl.addEventListener('pointerdown', onDown);
    rootEl.addEventListener('pointermove', onMove);
    rootEl.addEventListener('pointerup', onUp);
    rootEl.addEventListener('pointercancel', onUp);
    rootEl.addEventListener('pointerenter', onEnter);
    rootEl.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    return () => {
      rootEl.removeEventListener('wheel', onWheel);
      rootEl.removeEventListener('pointerdown', onDown);
      rootEl.removeEventListener('pointermove', onMove);
      rootEl.removeEventListener('pointerup', onUp);
      rootEl.removeEventListener('pointercancel', onUp);
      rootEl.removeEventListener('pointerenter', onEnter);
      rootEl.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
      setContentHover(false);
    };
    // The handlers only read refs.
  }, [rootEl]);

  useFrame((state, dt) => {
    const time = state.clock.elapsedTime;
    const s = st.current;
    const fade = sceneState.depthFade.content;

    // The navigation row under the focus, eased toward the drop that keeps it
    // below the satellites: quickly down, slowly back up.
    const float = floatingOffset(time, 4.2, 0.04, 0.04, 0.03);
    const push = (info.current.userData.push ??= new THREE.Vector3());
    const down = sceneState.buttonsNudge.y < push.y;
    push.lerp(sceneState.buttonsNudge, 1 - Math.exp(-(down ? 8 : 0.8) * dt));
    info.current.position.set(
      layout.center.x + float.x + push.x,
      layout.center.y + layout.infoY + float.y + push.y,
      layout.center.z + 0.2 + push.z
    );
    info.current.scale.setScalar(damp(info.current.scale.x, 1, 6, dt));

    // ---- The wire, once the focus has landed; the screen switches on
    // when it is in.
    const focusGroup = sceneState.registry.get(node.id);
    if (s.wireAt === undefined && hasLanded(focusGroup)) s.wireAt = time;
    let entry = 0; // where the trunk meets the screen, above its centre
    let fit = 1; // how far the board is shrunk
    let shown = null; // which of its ports have a trace drawn
    if (focusGroup && wire.current) {
      const out = drawPanelWire(wireBuf, {
        board,
        camera: state.camera,
        focus: focusGroup,
        box,
        time,
        at: s.wireAt,
        color: colors.fg,
        fade,
      });
      entry = out.entry;
      fit = out.fit;
      shown = out.shown;
      const geom = wire.current.geometry;
      geom.setDrawRange(0, out.count * 2);
      geom.attributes.position.needsUpdate = true;
      geom.attributes.color.needsUpdate = true;
    }
    const d = dom.current;
    if (!d.root || !d.body || !d.wrap) return;
    const powerAt = s.wireAt === undefined ? Infinity : s.wireAt + WIRE_TIME;
    if (!s.on && time >= powerAt) {
      s.on = true;
      d.root.classList.add('is-on');
    }
    // Switching on like an old monitor: a bright line, opening out with a
    // little overshoot, a flicker.
    const p = (time - powerAt) / POWER_TIME;
    if (p >= 0 && p < 1) {
      const open = p < 0.3 ? 0.004 : p < 0.65 ? 0.004 + 1.026 * (1 - Math.pow(1 - (p - 0.3) / 0.35, 3)) : 1.03 - 0.03 * ((p - 0.65) / 0.35);
      d.root.style.transform = `scale(1, ${open})`;
      d.root.style.filter = `brightness(${1 + 2 * (1 - p)})`;
      d.root.style.opacity = p > 0.72 && p < 0.8 ? 0.55 : 1;
    } else if (p >= 1 && d.root.style.transform) {
      d.root.style.transform = '';
      d.root.style.filter = '';
      d.root.style.opacity = '';
    }
    d.wrap.style.opacity = fade;
    d.wrap.style.pointerEvents = s.on && fade > 0.5 ? 'auto' : 'none';
    // The board's ports on the left edge, in the rail's own pixels.
    const portPx = ((box.top - box.bottom) / 2 - entry) / scale - BODY_TOP;
    d.ports.forEach((el, i) => {
      if (!el) return;
      el.style.top = `${portPx - (board.ports[i] * fit) / scale}px`;
      el.style.display = shown && !shown[i] ? 'none' : '';
    });

    // ---- Scrolling, and scrolling itself till the user does.
    const max = maxScroll();
    const a = s.auto;
    if (a.on && s.on && max > 0) {
      a.wait ??= time + AUTO_DELAY;
      if (a.back) {
        s.target = Math.max(0, s.target - AUTO_RETURN * dt);
        if (s.target === 0) {
          a.back = false;
          a.wait = time + AUTO_DELAY;
        }
      } else if (time >= a.wait) {
        if (s.target < max) {
          s.target = Math.min(max, s.target + AUTO_SPEED * dt);
        } else if ((a.endAt ??= time) + AUTO_HOLD < time) {
          a.back = true;
          a.endAt = null;
        }
      }
    }
    s.target = Math.min(s.target, max);
    s.pos = damp(s.pos, s.target, 7, dt);
    d.body.scrollTop = s.pos;
    const viewH = d.body.clientHeight;

    // ---- The blocks: sparks, typing, the one being read.
    let current = -1;
    d.blocks.forEach((b, i) => {
      const bs = s.blocks[i];
      if (!b?.el || !bs) return;
      const top = b.el.offsetTop - s.pos;
      const h = b.el.offsetHeight;
      const spark = d.sparks[i];
      if (current < 0 && top + h > viewH * 0.3) current = i;
      // Fading out as it nears the top or bottom edge.
      const edgeFade = THREE.MathUtils.clamp(Math.min(top + h, viewH - top) / EDGE_FADE, 0, 1);
      if (b.fade !== edgeFade) {
        b.fade = edgeFade;
        b.el.style.opacity = edgeFade;
      }
      // Scrolled right out of view: it comes on all over again when back.
      if (top + h < -8 || top > viewH + 8) {
        if (bs.state !== 'idle') {
          bs.state = 'idle';
          b.el.classList.remove('is-on', 'is-swept');
          for (const t of b.typed) if (t) t.textContent = '';
          if (spark) spark.style.opacity = 0;
        }
        return;
      }
      if (bs.state === 'idle') {
        if (!s.on || time < powerAt + POWER_TIME || time < s.lastSpark + STAGGER || top > viewH - 24) return;
        bs.state = 'spark';
        bs.t0 = time;
        s.lastSpark = time;
      }
      if (bs.state === 'spark') {
        const p = Math.min(1, (time - bs.t0) / SPARK_TIME);
        const to = THREE.MathUtils.clamp(top + 16, 0, viewH);
        if (spark) {
          spark.style.top = `${portPx + (to - portPx) * (1 - Math.pow(1 - p, 3))}px`;
          spark.style.opacity = p < 1 ? 1 : 0;
        }
        if (p < 1) return;
        bs.state = 'type';
        bs.t0 = time;
        b.el.classList.add('is-on');
      }
      if (bs.state === 'type') {
        const rate = Math.max(TYPE_RATE, b.total / TYPE_MAX);
        let left = Math.floor((time - bs.t0) * rate);
        b.lines.forEach((line, j) => {
          const t = b.typed[j];
          const shown = Math.max(0, Math.min(line.length, left));
          left -= line.length;
          if (!t) return;
          if (t.textContent.length !== shown) t.textContent = line.slice(0, shown);
          t.parentElement.classList.toggle('is-typing', shown > 0 && shown < line.length);
        });
        if (left >= 0) {
          bs.state = 'done';
          b.el.classList.add('is-swept');
        }
      }
    });
    if (current !== s.current) {
      if (d.blocks[s.current]) d.blocks[s.current].el.classList.remove('is-current');
      if (d.blocks[current]) d.blocks[current].el.classList.add('is-current');
      s.current = current;
      d.count.textContent = `${pad2(Math.max(0, current) + 1)}/${pad2(blocks.length)}`;
    }
    d.bar.style.width = `${max > 0 ? (s.pos / max) * 100 : 100}%`;
    d.mode.textContent = a.on ? 'AUTO' : 'MANUAL';
  });

  // The frame: cut top-left and bottom-right, bright on the cuts.
  const W = widthPx;
  const H = heightPx;
  const shape = `${CUT},0.5 ${W - 0.5},0.5 ${W - 0.5},${H - CUT} ${W - CUT},${H - 0.5} 0.5,${H - 0.5} 0.5,${CUT}`;
  const set = (key) => (el) => {
    dom.current[key] = el;
  };

  return (
    <>
      <group ref={info} scale={0.001}>
        <Billboard>
          {/* Back, out to the whole universe, forward — a step that isn't
              there yet stays in place, dimmed. */}
          <Button position={[-NAV_STEP, NAV_Y, 0]} colors={colors} font={font} onClick={goBack} disabled={!canBack}>
            {'<<PREV'}
          </Button>
          <Button position={[0, NAV_Y, 0]} colors={colors} font={font} onClick={resetView}>
            [ESC]
          </Button>
          <Button position={[NAV_STEP, NAV_Y, 0]} colors={colors} font={font} onClick={goForward} disabled={!canForward}>
            {'NEXT>>'}
          </Button>
        </Billboard>
      </group>

      {/* The wire, drawn before any text: it runs under words, never over. */}
      <lineSegments ref={wire} frustumCulled={false} renderOrder={1}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" array={wireBuf.positions} count={WIRE_SEGMENTS * 2} itemSize={3} />
          <bufferAttribute attach="attributes-color" array={wireBuf.colors} count={WIRE_SEGMENTS * 2} itemSize={3} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>

      {/* In transform mode drei maps 1 CSS px to distanceFactor / 400 world units. */}
      <Html
        transform
        sprite
        center
        position={[box.x, (box.top + box.bottom) / 2, box.z]}
        distanceFactor={scale * 400}
        zIndexRange={[5, 0]}
      >
        <div ref={set('wrap')} style={{ opacity: 0 }}>
          <div
            className="holo"
            style={{ width: W, height: H }}
            ref={(el) => {
              dom.current.root = el;
              if (el && el !== rootEl) setRootEl(el);
            }}
          >
            <svg className="holo__frame" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
              <polygon className="shape" points={shape} />
              <line className="rule" x1={CUT + 6} y1={BODY_TOP - 4} x2={W - 12} y2={BODY_TOP - 4} />
              <line className="rule" x1={12} y1={H - 30} x2={W - CUT - 6} y2={H - 30} />
              <polyline className="accent" points={`0.5,${CUT + 14} 0.5,${CUT} ${CUT},0.5 ${CUT + 14},0.5`} />
              <polyline
                className="accent"
                points={`${W - CUT - 14},${H - 0.5} ${W - CUT},${H - 0.5} ${W - 0.5},${H - CUT} ${W - 0.5},${H - CUT - 14}`}
              />
              <polyline className="accent" points={`${W - 16},0.5 ${W - 0.5},0.5 ${W - 0.5},16`} />
              <polyline className="accent" points={`0.5,${H - 16} 0.5,${H - 0.5} 16,${H - 0.5}`} />
            </svg>

            <header className="holo__head">
              <span className="holo__dot" />
              <span className="holo__title">{node.title}</span>
              <span className="holo__cat">[{String(node.category ?? '').toUpperCase()}]</span>
              <span className="holo__count" ref={set('count')}>
                01/{pad2(blocks.length)}
              </span>
            </header>

            <div className="holo__rail">
              {board.ports.map((_, i) => (
                <div
                  key={i}
                  className="holo__port"
                  ref={(el) => {
                    dom.current.ports[i] = el;
                  }}
                />
              ))}
              {blocks.map((_, i) => (
                <div
                  key={i}
                  className="holo__spark"
                  ref={(el) => {
                    dom.current.sparks[i] = el;
                  }}
                />
              ))}
            </div>

            <div className="holo__body" ref={set('body')}>
              <div className="holo__content" ref={set('content')}>
                {blocks.map((b, i) => (
                  <Block
                    key={i}
                    block={b}
                    onMount={(entry) => {
                      dom.current.blocks[i] = entry;
                    }}
                  />
                ))}
                <div className="holo__end">// END OF {String(node.title).toUpperCase()}</div>
              </div>
            </div>

            <footer className="holo__foot">
              <span ref={set('mode')}>AUTO</span>
              <div className="holo__bar">
                <div className="holo__barfill" ref={set('bar')} />
              </div>
              <span>SCROLL</span>
            </footer>
            <div className="holo__scan" />
          </div>
        </div>
      </Html>
    </>
  );
}

/**
 * One block on the screen: every line laid out in full (hidden) so the
 * scroll never jumps, with the typed part over it (filled in by
 * ContentScreen's frame loop, through the entry handed to `onMount`).
 */
function Block({ block, onMount }) {
  const typed = useRef([]);
  const frame = useRef();
  const doc = useMemo(() => (block.kind === 'preview' ? previewDoc(block.html) : null), [block]);
  const lines = useMemo(() => block.lines.map((l) => (bullet(block, l) ? l.slice(2) : l)), [block]);
  return (
    <section
      className={`blk blk--${block.kind}`}
      ref={(el) => {
        if (!el) return;
        onMount({
          el,
          lines,
          total: lines.reduce((n, l) => n + l.length, 0),
          typed: typed.current,
          frame: frame.current,
        });
      }}
    >
      {lines.map((line, j) => (
        <div key={j} className={`ln${bullet(block, block.lines[j]) ? ' is-bullet' : ''}`}>
          <span className="ln__ghost">{line || ' '}</span>
          <span
            className="ln__t"
            ref={(el) => {
              typed.current[j] = el;
            }}
          />
        </div>
      ))}
      {doc && (
        <iframe
          ref={frame}
          title="Kết quả trực tiếp"
          sandbox="allow-scripts allow-modals allow-forms"
          srcDoc={doc}
          style={{ height: 40 }}
        />
      )}
      <div className="blk__sweep" />
    </section>
  );
}

// The navigation buttons: plain text in the search bar's green
// (styles/global.css, --fg); hovered, lit up; unavailable, dimmed like its
// placeholder.
const BUTTON_H = 0.24;
const BUTTON_DIM = 0.4;

function Button({ onClick, colors, font, children, position, disabled = false }) {
  const [hover, setHover] = useState(false);
  const [width, setWidth] = useState(0.6);
  return (
    <group
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        if (disabled) return;
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = 'auto';
      }}
    >
      {/* Hit area well beyond the glyphs, a comfortable finger target. */}
      <mesh position={[0, 0, -0.006]}>
        <planeGeometry args={[width + 0.2, BUTTON_H + 0.14]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Text
        font={font}
        fontSize={0.12}
        color={hover && !disabled ? colors.highlight : colors.fg}
        fillOpacity={disabled ? BUTTON_DIM : 1}
        anchorX="center"
        anchorY="middle"
        onSync={(mesh) => {
          const b = mesh.textRenderInfo?.blockBounds;
          if (b) setWidth(b[2] - b[0]);
        }}
      >
        {children}
      </Text>
    </group>
  );
}

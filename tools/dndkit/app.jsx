/* The drag-and-drop question, built on the real @dnd-kit/core — the library the
   live site uses (its hidden "Draggable item … was dropped over droppable area …"
   announcement is dnd-kit's default wording). So what the library renders on its
   own — the attributes on a draggable, the screen-reader instructions, the live
   region, how a drag starts and how a drop target is chosen — is the real thing, not
   a guess at it. Only the look and the surrounding page are mine.

   Query string:
     sensor=pointer|distance|delay|mouse   what is allowed to start a drag
     collision=rect|pointer|center         how the drop target is chosen
     overlay=1                             draw the dragged item in a <DragOverlay>
     zones=dashed|pseudo|plain             how the gaps are drawn            */

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, PointerSensor, TouchSensor,
  closestCenter, pointerWithin, rectIntersection,
  useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';

const q = new URLSearchParams(location.search);
const SENSOR = q.get('sensor') || 'pointer';
const COLLISION = { rect: rectIntersection, pointer: pointerWithin, center: closestCenter }[q.get('collision') || 'rect'];
const OVERLAY = q.has('overlay');
const CHIP = q.get('overlay') === 'chip';
const ZONES = q.get('zones') || 'dashed';

// ?nextword=1: the first item reads "next steps", as one did on the live page — which a lesson run
// took for the Next button.
const ITEMS = [q.has('nextword') ? 'next steps' : 'quantity', 'tuition fees', 'consumerism', 'vision', 'wages', 'hire'];
const EXPECTED = ['tuition fees', 'hire', 'vision'];

window.__sideClicks = 0;
window.__filled = [null, null, null];

// How long the pointer rested after its last move before it was released, for each drag.
window.__restBeforeUp = [];
let lastMoveAt = 0;
document.addEventListener('pointermove', () => { lastMoveAt = performance.now(); }, true);
document.addEventListener('pointerup', () => { if (lastMoveAt) { window.__restBeforeUp.push(performance.now() - lastMoveAt); lastMoveAt = 0; } }, true);

const Grip = () => (
  <svg className="grip" viewBox="0 0 12 16" aria-hidden="true">
    <circle cx="3" cy="3" r="1.4" /><circle cx="9" cy="3" r="1.4" /><circle cx="3" cy="8" r="1.4" />
    <circle cx="9" cy="8" r="1.4" /><circle cx="3" cy="13" r="1.4" /><circle cx="9" cy="13" r="1.4" />
  </svg>
);

const Icon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h8v2H4v8H2zM6 6l8 4-3 1 2 3-1.5 1-2-3-2 2z" /></svg>
);

function Chip({ id, word }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <button ref={setNodeRef} style={style} type="button" className={`item${isDragging ? ' dragging' : ''}`} {...listeners} {...attributes}>
      <Grip /><span>{word}</span>
    </button>
  );
}

function Gap({ index, item }) {
  const { setNodeRef, isOver } = useDroppable({ id: `gap-${index}` });
  return (
    <span ref={setNodeRef} data-z={index} className={`zone${item != null ? ' filled' : ''}${isOver ? ' over' : ''}`}>
      {item != null ? <Chip id={`placed-${item}`} word={ITEMS[item]} /> : <Icon />}
    </span>
  );
}

function Pool({ children }) {
  const { setNodeRef } = useDroppable({ id: 'options-pool' });
  return <div ref={setNodeRef} className="tray" id="tray">{children}</div>;
}

function App() {
  const [placed, setPlaced] = useState([null, null, null]);   // gap -> index into ITEMS
  const [active, setActive] = useState(null);
  const [graded, setGraded] = useState(null);

  const sensors = useSensors(
    ...(SENSOR === 'keyboard' ? []                      // only the keyboard may start a drag
      : SENSOR === 'mouse'
      ? [useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
         useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })]
      : [useSensor(PointerSensor,
          SENSOR === 'distance' ? { activationConstraint: { distance: 8 } }
          : SENSOR === 'delay' ? { activationConstraint: { delay: 250, tolerance: 5 } }
          : undefined)]),
    useSensor(KeyboardSensor),
  );

  useEffect(() => { window.__filled = placed.map(i => (i == null ? null : ITEMS[i])); }, [placed]);

  const idOf = id => Number(String(id).split('-')[1]);
  const onDragEnd = ({ active: a, over }) => {
    setActive(null);
    if (!over) return;
    const item = idOf(a.id), to = String(over.id);
    setPlaced(prev => {
      const next = prev.slice();
      const from = next.indexOf(item);
      if (to.startsWith('gap-')) {
        const g = idOf(to);
        if (next[g] != null) return prev;
        if (from >= 0) next[from] = null;
        next[g] = item;
        return next;
      }
      if (to === 'options-pool' && from >= 0) { next[from] = null; return next; }
      return prev;
    });
  };

  const full = placed.every(v => v != null);
  const submit = () => {
    const ok = placed.every((v, i) => ITEMS[v] === EXPECTED[i]);
    window.__dragSubmitted = true;
    window.__dragCorrect = ok;
    setGraded(ok);
  };

  return (
    <div id="root" className={`zones-${ZONES}${CHIP ? ' wide-rows' : ''}`}>
      <aside style={{ position: 'fixed', right: 6, top: 70, width: 150, zIndex: 5, fontSize: 12 }}>
        <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Sample Lesson</p>
        <nav>
          <button id="side" style={{ width: '100%', padding: 8 }} onClick={() => { window.__sideClicks += 1; }}>Check My Understanding</button>
          {Array.from({ length: 15 }, (_, i) => <div key={i}>Question {i + 1}</div>)}
        </nav>
      </aside>

      <div className="layout">
        <DndContext sensors={sensors} collisionDetection={COLLISION}
                    onDragStart={e => setActive(idOf(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
          <div className="left">
            <h4>Drag each item to the correct place.</h4>
            <p>Rising <Gap index={0} item={placed[0]} /> create significant pressure on students and their families.</p>
            <p>Companies <Gap index={1} item={placed[1]} /> specialists for professionalism and growth. .</p>
            <p>A clear <Gap index={2} item={placed[2]} /> can shape a business strategy and move it forward.</p>
          </div>
          <Pool>
            {ITEMS.map((w, i) => (placed.includes(i) ? null : <Chip key={i} id={`pool-${i}`} word={w} />))}
          </Pool>
          {OVERLAY && (
            // overlay=chip: the overlay is only as big as the label, drawn from the row's own top-left
            // corner — as on the live page, where a tray row is far wider than the word in it. The
            // library then judges "over what?" by the label's small box, not by the row's.
            <DragOverlay style={CHIP ? { width: 'auto', height: 'auto' } : undefined}>
              {active != null ? <div className="item overlay" style={CHIP ? { width: 'auto', padding: '0 14px' } : undefined}><Grip /><span>{ITEMS[active]}</span></div> : null}
            </DragOverlay>
          )}
        </DndContext>
      </div>

      <div className="foot">
        <button id="back" type="button">‹ Go Back</button>
        <button id="submit" type="submit" className="lib-btn-next" disabled={!full || graded != null} onClick={submit}>
          {graded == null ? 'Submit Answer ›' : graded ? 'Correct' : 'Incorrect'}
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('app')).render(<App />);

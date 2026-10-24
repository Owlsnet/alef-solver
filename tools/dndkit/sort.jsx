/* The ordering question ("Arrange the items in the correct order"), built on the real
   @dnd-kit/core and @dnd-kit/sortable — the libraries the live site uses (its hidden
   "Draggable item … was dropped over droppable area …" text is dnd-kit's own wording, and
   its items carry aria-roledescription="sortable", which is what useSortable puts on a node).
   What the library renders by itself — those attributes, the screen-reader text, how a
   drag starts, which item counts as "over" — is the real thing. The markup around it copies
   the live page's structure (class names, the handle image, the hidden text).

   Query string:
     sensor=pointer|distance|delay|keyboard   what may start a drag. `keyboard` allows only
                                              Space and the arrows, so a pointer drag fails
     handle=1                                 only the grip image starts a drag            */

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const q = new URLSearchParams(location.search);
const SENSOR = q.get('sensor') || 'pointer';
const HANDLE_ONLY = q.has('handle');

const ITEMS = [
  { id: 'a', text: <>falling tone on <em>eighty</em> to state total</>, plain: 'falling tone on eighty to state total' },
  { id: 'b', text: <>rising tone on <em>dirhams</em> for the question</>, plain: 'rising tone on dirhams for the question' },
  { id: 'c', text: <>flat tone on <em>receipt</em> showing more follows</>, plain: 'flat tone on receipt showing more follows' },
];
const EXPECTED = ['b', 'a', 'c'];

window.__sideClicks = 0;

const HANDLE = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="28"><g fill="#4a5568">' +
  '<circle cx="4" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="4" cy="14" r="2"/>' +
  '<circle cx="14" cy="14" r="2"/><circle cx="4" cy="22" r="2"/><circle cx="14" cy="22" r="2"/></g></svg>');

function SortItem({ item }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  const handleProps = HANDLE_ONLY ? { ref: setActivatorNodeRef, ...listeners } : {};
  return (
    <div ref={setNodeRef} style={style} className="lib-sort-item" {...attributes} {...(HANDLE_ONLY ? {} : listeners)}>
      <img className="lib-sorting-handle" src={HANDLE} alt="" width="18" height="28" {...handleProps} />
      <span className="lib-html-container lib-html-text"><span><span className="lib-html-text-wrapper">{item.text}</span></span></span>
    </div>
  );
}

function App() {
  const [order, setOrder] = useState(ITEMS.map(i => i.id));
  const [changed, setChanged] = useState(false);
  const [graded, setGraded] = useState(null);
  const [skipped, setSkipped] = useState(false);              // &later=1: "I'll try later" was pressed

  const sensors = useSensors(
    ...(SENSOR === 'keyboard' ? [] : [useSensor(PointerSensor,
      SENSOR === 'distance' ? { activationConstraint: { distance: 8 } }
      : SENSOR === 'delay' ? { activationConstraint: { delay: 250, tolerance: 5 } } : undefined)]),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => { window.__order = order.map(id => ITEMS.find(i => i.id === id).plain); }, [order]);

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setOrder(prev => arrayMove(prev, prev.indexOf(active.id), prev.indexOf(over.id)));
    setChanged(true);                                  // Submit stays greyed out until the list has been changed
  };

  const submit = () => {
    const ok = order.every((id, i) => id === EXPECTED[i]);
    window.__sortSubmitted = true;
    window.__sortCorrect = ok;
    setGraded(ok);
  };

  return (
    <div id="root">
      <aside style={{ position: 'fixed', right: 6, top: 70, width: 150, zIndex: 5, fontSize: 12 }}>
        <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Sample Lesson</p>
        <nav>
          <button id="side" style={{ width: '100%', padding: 8 }} onClick={() => { window.__sideClicks += 1; }}>Check My Understanding</button>
        </nav>
      </aside>

      <div className="lib-sorting-container">
        <div className="lib-widget-header-top-section">
          <button type="button" aria-label="Play audio" className="audio">🔊</button>
          <button type="button" aria-label="Need Help?" className="help">Need Help?</button>
        </div>
        <div className="lib-sorting-wrapper">
          <div className="lib-question-statement-container">
            <span className="lib-html-container lib-html-text"><span><span className="lib-html-text-wrapper">
              Put these pitch patterns in the order they occur in the conversation when discussing the grocery total.
            </span></span></span>
          </div>
          <h3 id="question-instruction" className="lib-question-instruction">Arrange the items in the correct order.</h3>
          <div className="lib-question-interactive-container">
            {skipped ? <p id="skipped">Skipped.</p> : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={order} strategy={verticalListSortingStrategy}>
                  {order.map(id => <SortItem key={id} item={ITEMS.find(i => i.id === id)} />)}
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>
        <div className="lib-sorting-image-wrapper"><div className="pic" /></div>
      </div>

      <div className="foot">
        <button id="back" type="button">‹ Go Back</button>
        {q.has('later') && !skipped && (
          <button id="later" type="button" onClick={() => { window.__later = (window.__later || 0) + 1; setSkipped(true); }}>I'll try later</button>
        )}
        <button id="submit" type="submit" className="lib-btn-next" disabled={!changed || graded != null} onClick={submit}>
          {graded == null ? 'Submit Answer ›' : graded ? 'Correct' : 'Incorrect'}
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('app')).render(<App />);

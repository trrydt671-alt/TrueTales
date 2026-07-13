import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import { api } from '../api.js';

// Gap between the virtual "columns" (pages) of the paginated text.
const GAP = 60;
// Inner padding of a text page (must match .fb-textpage / .fb-measure CSS).
const PAD_X = 22;
const PAD_Y = 20;

const LEVEL_LABELS = { easy: 'Easy & Clear', standard: 'Standard', rich: 'Rich & Literary' };
const FORM_LABELS = { cinematic: 'Cinematic', documentary: 'Documentary', bedtime: 'Bedtime-story', journalistic: 'Journalistic' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default function Reader() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [book, setBook] = useState(null);
  const [error, setError] = useState(null);

  const areaRef = useRef(null);     // the visible page area (defines page size)
  const measureRef = useRef(null);  // hidden clone used to count pages

  const [dims, setDims] = useState(null);           // { w, h } of one page
  const [textPages, setTextPages] = useState(null); // number of text pages
  const [page, setPage] = useState(0);              // 0 = cover
  const [flip, setFlip] = useState(null);           // { from, to, dir: 'fwd'|'back' }
  const touchRef = useRef(null);

  // Weak devices / reduced motion: skip the 3D page turn, change instantly.
  const simpleMode = useMemo(() => {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
      if (navigator.deviceMemory && navigator.deviceMemory <= 2) return true;
      if (!(window.CSS && CSS.supports('transform-style', 'preserve-3d'))) return true;
      return false;
    } catch {
      return true;
    }
  }, []);

  useEffect(() => {
    api.getBook(id).then(setBook).catch((e) => setError(e.message));
  }, [id]);

  // Build the full book HTML once: title page + chapters + sources.
  const contentHtml = useMemo(() => {
    if (!book) return '';
    const body = book.content.replace(/^#\s+.+$/m, '').trim();
    const prose = marked.parse(body, { breaks: false });

    const styleBits = [];
    if (LEVEL_LABELS[book.reading_level]) styleBits.push(LEVEL_LABELS[book.reading_level]);
    if (FORM_LABELS[book.story_form]) styleBits.push(FORM_LABELS[book.story_form]);
    const meta = [
      'A true story',
      new Date(book.created_at).toLocaleDateString(),
      ...styleBits,
    ].join(' · ');

    const titlePage =
      `<header class="fb-titlepage"><h1>${esc(book.title)}</h1><p class="fb-meta">${esc(meta)}</p></header>`;

    let sources = '';
    if (book.sources?.length) {
      const items = book.sources
        .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title)}</a></li>`)
        .join('');
      sources = `<section class="fb-sources"><h2>Sources</h2><ul>${items}</ul></section>`;
    }

    return titlePage + prose + sources;
  }, [book]);

  // Measure the page area (and re-measure on resize / rotation).
  useLayoutEffect(() => {
    if (!book) return;
    const measure = () => {
      const el = areaRef.current;
      if (!el) return;
      setDims((d) => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        return d && d.w === w && d.h === h ? d : { w, h };
      });
    };
    measure();
    let t = null;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(measure, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [book]);

  // Count how many pages the text flows into (CSS columns do the pagination).
  useLayoutEffect(() => {
    if (!dims || !contentHtml) return;
    const el = measureRef.current;
    if (!el) return;
    const cw = dims.w - PAD_X * 2;
    const n = Math.max(1, Math.round((el.scrollWidth + GAP) / (cw + GAP)));
    setTextPages(n);
    // Restore the last page the reader was on (cover = 0).
    const saved = parseInt(localStorage.getItem(`tt-pos-${id}`) || '0', 10);
    setPage(Number.isFinite(saved) ? Math.min(Math.max(saved, 0), n) : 0);
  }, [dims, contentHtml, id]);

  const total = textPages == null ? null : textPages + 1; // + cover

  // Remember position per book.
  useEffect(() => {
    if (total != null) localStorage.setItem(`tt-pos-${id}`, String(page));
  }, [page, total, id]);

  const go = (dir) => {
    if (flip || total == null) return;
    const target = page + dir;
    if (target < 0 || target >= total) return;
    if (simpleMode) {
      setPage(target);
      return;
    }
    setFlip({ from: page, to: target, dir: dir > 0 ? 'fwd' : 'back' });
  };

  const onFlipEnd = () => {
    if (!flip) return;
    setPage(flip.to);
    setFlip(null);
  };

  // Keyboard (desktop) support.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onPointerDown = (e) => {
    touchRef.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start || total == null) return;
    if (e.target.closest('a')) return; // let source links work normally
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      go(dx < 0 ? 1 : -1); // swipe left = forward, swipe right = back
      return;
    }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      const rect = e.currentTarget.getBoundingClientRect();
      const rel = (e.clientX - rect.left) / rect.width;
      if (rel < 0.35) go(-1);
      else if (rel > 0.65) go(1);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete “${book.title}” from your library?`)) return;
    await api.deleteBook(id);
    localStorage.removeItem(`tt-pos-${id}`);
    navigate('/', { replace: true });
  };

  if (error) return <div className="page"><p className="error-box">{error}</p></div>;
  if (!book) return <div className="page"><div className="spinner" /></div>;

  const cw = dims ? dims.w - PAD_X * 2 : 0;
  const ch = dims ? dims.h - PAD_Y * 2 : 0;
  const contentStyle = dims
    ? {
        width: `${cw}px`,
        height: `${ch}px`,
        columnWidth: `${cw}px`,
        columnGap: `${GAP}px`,
      }
    : null;

  // One face of a page: the cover, or a window onto the paginated text.
  const face = (idx) =>
    idx === 0 ? (
      <div className="fb-cover">
        <img src={book.cover_url} alt={book.title} draggable="false" />
      </div>
    ) : (
      <div className="fb-textpage">
        <div
          className="fb-content prose"
          style={{ ...contentStyle, transform: `translateX(-${(idx - 1) * (cw + GAP)}px)` }}
          dangerouslySetInnerHTML={{ __html: contentHtml }}
        />
      </div>
    );

  const baseIdx = flip ? (flip.dir === 'fwd' ? flip.to : flip.from) : page;
  const flipIdx = flip ? (flip.dir === 'fwd' ? flip.from : flip.to) : null;

  return (
    <div className="flipbook">
      <nav className="fb-nav">
        <Link to="/" className="btn btn-small">← Library</Link>
        <div className="row">
          <Link to={`/book/${id}/edit`} className="btn btn-small">Edit</Link>
          <button className="btn btn-small btn-danger" onClick={remove}>Delete</button>
        </div>
      </nav>

      <div className="fb-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <div className="fb-area" ref={areaRef}>
          {dims && total != null ? (
            <>
              <div className="fb-base">{face(baseIdx)}</div>
              {flip && (
                <div className={`fb-flip fb-flip-${flip.dir}`} onAnimationEnd={onFlipEnd}>
                  <div className="fb-face fb-front">{face(flipIdx)}</div>
                  <div className="fb-face fb-back" />
                </div>
              )}
            </>
          ) : (
            <div className="spinner" />
          )}

          {/* hidden clone used only to count pages */}
          {dims && (
            <div className="fb-measure" aria-hidden="true">
              <div
                className="fb-content prose"
                ref={measureRef}
                style={contentStyle}
                dangerouslySetInnerHTML={{ __html: contentHtml }}
              />
            </div>
          )}
        </div>
      </div>

      {total != null && (
        <div className="fb-count">{page + 1} / {total}</div>
      )}
    </div>
  );
}

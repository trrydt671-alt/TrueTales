import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

const TONES = [
  { id: 'dramatic',    label: 'Dramatic',          emoji: '🎭' },
  { id: 'dark',        label: 'Dark & Haunting',   emoji: '🌑' },
  { id: 'heroic',      label: 'Heroic',            emoji: '🛡️' },
  { id: 'adventurous', label: 'Adventurous',       emoji: '🧭' },
  { id: 'tragic',      label: 'Tragic',            emoji: '🥀' },
  { id: 'triumphant',  label: 'Triumphant',        emoji: '🏆' },
  { id: 'mysterious',  label: 'Mysterious',        emoji: '🔍' },
  { id: 'intimate',    label: 'Intimate & Human',  emoji: '🕯️' },
  { id: 'witty',       label: 'Witty & Playful',   emoji: '🪶' },
];

const LENGTHS = [
  { id: 'short',  label: 'Short',  desc: '~10 min read' },
  { id: 'medium', label: 'Medium', desc: '~20 min read' },
  { id: 'long',   label: 'Long',   desc: '~35 min read' },
];

const PHASE_TEXT = {
  researching: 'Researching the real facts…',
  writing: 'Writing the chapters…',
  illustrating: 'Painting the cover…',
  saving: 'Placing it on your shelf…',
};

const FLAVOR = [
  'Digging through the archives',
  'Cross-checking the dates',
  'Interviewing the historians',
  'Following the paper trail',
  'Finding the perfect opening line',
  'Sharpening the pencils',
];

export default function NewBook() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [subject, setSubject] = useState('');
  const [extraContext, setExtraContext] = useState('');
  const [length, setLength] = useState('medium');
  const [tones, setTones] = useState([]);
  const [job, setJob] = useState(null); // { id, status }
  const [error, setError] = useState(null);
  const [flavorIdx, setFlavorIdx] = useState(0);
  const pollRef = useRef(null);

  const toggleTone = (id) =>
    setTones((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  const start = async () => {
    setError(null);
    try {
      const { jobId } = await api.generate({ subject, extraContext, length, tones });
      setJob({ id: jobId, status: 'researching' });
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    if (!job) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.jobStatus(job.id);
        if (s.status === 'done') {
          clearInterval(pollRef.current);
          navigate(`/book/${s.bookId}`, { replace: true });
        } else if (s.status === 'error') {
          clearInterval(pollRef.current);
          setError(s.error || 'Something went wrong');
          setJob(null);
        } else {
          setJob((j) => ({ ...j, status: s.status }));
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
        setJob(null);
      }
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [job?.id]);

  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setFlavorIdx((i) => (i + 1) % FLAVOR.length), 4000);
    return () => clearInterval(t);
  }, [job]);

  if (job) {
    return (
      <div className="page generating">
        <div className="book-loader">
          <div className="book-loader-page" />
          <div className="book-loader-page" />
          <div className="book-loader-page" />
        </div>
        <h2>{PHASE_TEXT[job.status] || 'Working…'}</h2>
        <p className="flavor">{FLAVOR[flavorIdx]}…</p>
        <p className="hint">
          Real research takes a couple of minutes. You can keep this open, or come back —
          the book will appear on your shelf when it&apos;s ready.
        </p>
      </div>
    );
  }

  return (
    <div className="page narrow">
      {step === 1 && (
        <div className="card">
          <h2>Who&apos;s the book about?</h2>
          <label className="field">
            <span>Name or subject</span>
            <input
              autoFocus
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Ada Lovelace, the Bristol Bus Boycott…"
            />
          </label>
          <label className="field">
            <span>Extra details <em>(optional)</em></span>
            <textarea
              value={extraContext}
              onChange={(e) => setExtraContext(e.target.value)}
              rows={3}
              placeholder="Anything to focus on, disambiguate, or include — e.g. 'the chess player, not the actor'"
            />
          </label>
          <button
            className="btn btn-primary btn-block"
            disabled={!subject.trim()}
            onClick={() => setStep(2)}
          >
            Next: choose the style →
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>How should it read?</h2>

          <div className="field">
            <span className="field-label">Length</span>
            <div className="segmented">
              {LENGTHS.map((l) => (
                <button
                  key={l.id}
                  className={length === l.id ? 'seg active' : 'seg'}
                  onClick={() => setLength(l.id)}
                >
                  <strong>{l.label}</strong>
                  <small>{l.desc}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Tone &amp; angle <em>(pick any)</em></span>
            <div className="chips">
              {TONES.map((t) => (
                <button
                  key={t.id}
                  className={tones.includes(t.id) ? 'chip active' : 'chip'}
                  onClick={() => toggleTone(t.id)}
                >
                  {t.emoji} {t.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="error-box">{error}</p>}

          <div className="row">
            <button className="btn" onClick={() => setStep(1)}>← Back</button>
            <button className="btn btn-primary grow" onClick={start}>
              ✨ Write the book
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

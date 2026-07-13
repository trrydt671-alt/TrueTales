import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';

export default function EditBook() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getBook(id).then((b) => {
      setTitle(b.title);
      setContent(b.content);
      setLoaded(true);
    }).catch((e) => setError(e.message));
  }, [id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateBook(id, { title, content });
      navigate(`/book/${id}`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  if (error && !loaded) return <div className="page"><p className="error-box">{error}</p></div>;
  if (!loaded) return <div className="page"><div className="spinner" /></div>;

  return (
    <div className="page narrow">
      <div className="card">
        <h2>Edit book</h2>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Text (Markdown — chapters start with ##)</span>
          <textarea
            className="editor"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={20}
          />
        </label>
        {error && <p className="error-box">{error}</p>}
        <div className="row">
          <Link to={`/book/${id}`} className="btn">Cancel</Link>
          <button className="btn btn-primary grow" onClick={save} disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

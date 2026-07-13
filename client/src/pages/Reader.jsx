import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import { api } from '../api.js';

export default function Reader() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [book, setBook] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getBook(id).then(setBook).catch((e) => setError(e.message));
  }, [id]);

  const remove = async () => {
    if (!confirm(`Delete “${book.title}” from your library?`)) return;
    await api.deleteBook(id);
    navigate('/', { replace: true });
  };

  if (error) return <div className="page"><p className="error-box">{error}</p></div>;
  if (!book) return <div className="page"><div className="spinner" /></div>;

  // Strip the H1 (we render the title ourselves) then convert markdown
  const body = book.content.replace(/^#\s+.+$/m, '').trim();
  const html = marked.parse(body, { breaks: false });

  return (
    <div className="reader">
      <nav className="reader-nav">
        <Link to="/" className="btn btn-small">← Library</Link>
        <div className="row">
          <Link to={`/book/${id}/edit`} className="btn btn-small">Edit</Link>
          <button className="btn btn-small btn-danger" onClick={remove}>Delete</button>
        </div>
      </nav>

      <div className="reader-cover">
        <img src={book.cover_url} alt={book.title} />
      </div>

      <article className="reader-body">
        <h1>{book.title}</h1>
        <p className="reader-meta">
          A true story · {new Date(book.created_at).toLocaleDateString()}
        </p>
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />

        {book.sources?.length > 0 && (
          <details className="sources">
            <summary>Sources ({book.sources.length})</summary>
            <ul>
              {book.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </article>
    </div>
  );
}

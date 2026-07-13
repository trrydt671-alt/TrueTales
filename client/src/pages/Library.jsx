import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Library() {
  const [books, setBooks] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listBooks().then(setBooks).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="page"><p className="error-box">{error}</p></div>;
  if (!books) return <div className="page"><div className="spinner" /></div>;

  if (books.length === 0) {
    return (
      <div className="page empty-state">
        <div className="empty-icon">📚</div>
        <h2>Your shelf is empty</h2>
        <p>Pick any real person or subject, and I&apos;ll research the facts and write you a little book about them.</p>
        <Link to="/new" className="btn btn-primary">Write my first book</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="shelf">
        {books.map((b) => (
          <Link key={b.id} to={`/book/${b.id}`} className="shelf-item">
            <div className="cover-wrap">
              <img src={b.cover_url} alt={b.title} loading="lazy" />
            </div>
            <div className="shelf-title">{b.title}</div>
            <div className="shelf-subject">{b.subject}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

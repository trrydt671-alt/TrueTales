import { Routes, Route, Link, useLocation } from 'react-router-dom';
import Library from './pages/Library.jsx';
import NewBook from './pages/NewBook.jsx';
import Reader from './pages/Reader.jsx';
import EditBook from './pages/EditBook.jsx';

export default function App() {
  const { pathname } = useLocation();
  const inReader = /^\/book\//.test(pathname);
  return (
    <div className="app">
      {!inReader && (
        <header className="app-header">
          <Link to="/" className="brand">
            <span className="brand-mark">❧</span> TrueTales
          </Link>
          {pathname === '/' && (
            <Link to="/new" className="btn btn-primary btn-small">+ New book</Link>
          )}
        </header>
      )}
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/new" element={<NewBook />} />
        <Route path="/book/:id" element={<Reader />} />
        <Route path="/book/:id/edit" element={<EditBook />} />
      </Routes>
    </div>
  );
}

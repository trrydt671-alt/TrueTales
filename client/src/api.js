async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  listBooks: () => req('/api/books'),
  getBook: (id) => req(`/api/books/${id}`),
  updateBook: (id, data) => req(`/api/books/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBook: (id) => req(`/api/books/${id}`, { method: 'DELETE' }),
  generate: (data) => req('/api/books/generate', { method: 'POST', body: JSON.stringify(data) }),
  jobStatus: (jobId) => req(`/api/generate/${jobId}`),
};

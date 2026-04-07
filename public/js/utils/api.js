/**
 * api.js — thin wrapper around fetch for REST API calls.
 */

const BASE = '/api';

async function request(method, path, body = undefined) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status });
  }
  return res.json();
}

export const api = {
  get:    (path)        => request('GET',    path),
  post:   (path, body)  => request('POST',   path, body),
  patch:  (path, body)  => request('PATCH',  path, body),
  delete: (path)        => request('DELETE', path),

  // ── Projects ─────────────────────────────────────────────────────────────
  listProjects:    ()           => api.get('/projects'),
  getProject:      (id)         => api.get(`/projects/${id}`),
  createProject:   (data)       => api.post('/projects', data),
  updateProject:   (id, data)   => api.patch(`/projects/${id}`, data),
  deleteProject:   (id)         => api.delete(`/projects/${id}`),

  // ── Sessions ──────────────────────────────────────────────────────────────
  listSessions:    ()           => api.get('/sessions'),
  getSession:      (id)         => api.get(`/sessions/${id}`),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings:     ()           => api.get('/settings'),
  updateSettings:  (data)       => api.patch('/settings', data),

  // ── Todos ─────────────────────────────────────────────────────────────────
  getTodos:        (projectId)              => api.get(`/todos/${projectId}`),
  addTodo:         (projectId, data)        => api.post(`/todos/${projectId}`, data),
  updateTodo:      (projectId, id, data)    => api.patch(`/todos/${projectId}/${id}`, data),
  deleteTodo:      (projectId, id)          => api.delete(`/todos/${projectId}/${id}`),

  // ── Files ─────────────────────────────────────────────────────────────────
  listFiles:       (path)       => api.get(`/files?path=${encodeURIComponent(path)}`),
};

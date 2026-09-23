// Fills in the version and status passed by the main process (?v=1.1.0).
const params = new URLSearchParams(location.search);
const version = params.get('v');
if (version) document.getElementById('version').textContent = `Version ${version}`;
window.addEventListener('message', (e) => {
  if (e.data && typeof e.data.status === 'string') document.getElementById('status').textContent = e.data.status;
});

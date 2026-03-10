// Main entry point for dashboard
// Dynamically loads bootstrap data from API instead of server-side rendering

async function loadBootstrap() {
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) {
      throw new Error(`Failed to load bootstrap: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Bootstrap load error:', error);
    showBootError(`Failed to load dashboard configuration: ${error.message}`);
    throw error;
  }
}

function showBootError(message) {
  const statusEl = document.getElementById('panel-status');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.classList.add('error');
    return;
  }

  const box = document.createElement('div');
  box.style.margin = '12px';
  box.style.padding = '10px 12px';
  box.style.border = '1px solid #d33';
  box.style.borderRadius = '6px';
  box.style.background = '#fff6f6';
  box.style.color = '#b00020';
  box.style.font = '14px/1.4 sans-serif';
  box.textContent = message;
  document.body.prepend(box);
}

// Initialize dashboard after bootstrap data is loaded
async function initDashboard() {
  const bootstrap = await loadBootstrap();

  // Inject bootstrap data into a script tag for compatibility with existing code
  const scriptEl = document.createElement('script');
  scriptEl.id = 'bootstrap-json';
  scriptEl.type = 'application/json';
  scriptEl.textContent = JSON.stringify(bootstrap);
  document.head.appendChild(scriptEl);

  // Load dashboard modules in order
  const modules = [
    '/assets/dashboard/dashboard_state.js',
    '/assets/dashboard/dashboard_data_loader.js',
    '/assets/math/dashboard_math3d.js',
    '/assets/dashboard/dashboard_plot.js',
    '/assets/dashboard/dashboard_ui.js'
  ];

  for (const src of modules) {
    await loadScript(src);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.body.appendChild(script);
  });
}

// Start initialization
initDashboard().catch(error => {
  console.error('Dashboard initialization failed:', error);
});

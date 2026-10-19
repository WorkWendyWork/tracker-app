// Runs before the page paints so the saved light/dark theme doesn't flash.
try { if (localStorage.getItem('theme') === 'light') document.documentElement.classList.remove('dark'); } catch (e) { /* storage blocked */ }

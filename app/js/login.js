(function () {
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  let nonce = '';

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
  }

  // If already logged in, skip straight to the dashboard.
  fetch('auth.php?check=1', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((data) => {
      if (data.authenticated) {
        window.location.replace('./');
      }
    })
    .catch(() => {});

  fetch('auth.php', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((data) => { nonce = data.nonce; })
    .catch(() => showError('Could not reach the server. Check your connection.'));

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    const body = new URLSearchParams({
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
      nonce: nonce,
    });

    fetch('auth.php', { method: 'POST', credentials: 'same-origin', body })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          window.location.replace('./');
        } else {
          showError(data.message || 'Invalid username or password');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Log in';
        }
      })
      .catch(() => {
        showError('Something went wrong. Try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log in';
      });
  });
})();

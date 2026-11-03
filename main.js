// The film is a plain link to YouTube until pressed, so no YouTube request is made on page load.
const film = document.querySelector('[data-youtube]');

film.addEventListener('click', (event) => {
  // Let modified clicks open YouTube in a new tab as usual.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${film.dataset.youtube}?autoplay=1&rel=0`;
  iframe.title = 'Meet Gnomi. Social simulation for product teams';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  const stage = document.createElement('div');
  stage.className = 'film-stage';
  stage.append(iframe);
  film.replaceWith(stage);
  iframe.focus();
});

for (const button of document.querySelectorAll('.copy')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
    } catch {
      // Clipboard access can be denied; select the commands so the visitor can copy them by hand.
      getSelection().selectAllChildren(code);
      button.textContent = 'Press ⌘C or Ctrl+C';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  });
}

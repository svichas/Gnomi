const video = document.querySelector('#hero-film');
const playButton = document.querySelector('.film-play');
const errorMessage = document.querySelector('.film-error');

// Keep native controls as the fallback when JavaScript is unavailable.
video.controls = false;
playButton.hidden = false;

playButton.addEventListener('click', async () => {
  playButton.hidden = true;
  errorMessage.hidden = true;
  video.controls = true;
  video.focus({ preventScroll: true });
  try {
    await video.play();
  } catch {
    // Native controls still allow playback if the browser rejects play().
    if (video.error) errorMessage.hidden = false;
  }
});

function showPlaybackError() {
  playButton.hidden = true;
  video.controls = true;
  errorMessage.hidden = false;
}

video.addEventListener('error', showPlaybackError);
// With a <source> child, initial load failures are reported on the source.
video.querySelector('source').addEventListener('error', showPlaybackError);

// Don't keep narration running after the visitor leaves the tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) video.pause();
});

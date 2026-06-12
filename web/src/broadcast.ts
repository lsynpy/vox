import { watch } from 'vue';

import { makeThumbnailURL } from './api/endpoints';
import { formatArtists, formatSong } from './format';
import { usePlaybackStore } from './stores/playback';

export default function setupBroadcasts() {
  const playback = usePlaybackStore();

  // Browser window title
  watch(
    () => playback.currentSong,
    (song) => {
      if (!song) {
        document.title = 'Vox';
        return;
      }

      document.title = formatSong(song);
    }
  );

  // Media session
  watch(
    () => playback.currentSong,
    (song) => {
      if (!navigator.mediaSession || !MediaMetadata) {
        return;
      }

      if (!song) {
        navigator.mediaSession.metadata = null;
        return;
      }

      const metadata = new MediaMetadata({
        title: song.title,
        album: song.album,
      });

      if (song.artists?.length) {
        metadata.artist = formatArtists(song.artists);
      } else if (song.album_artists?.length) {
        metadata.artist = formatArtists(song.album_artists);
      }

      if (song.artwork) {
        metadata.artwork = [{ src: makeThumbnailURL(song.artwork, 'small') }];
      }

      navigator.mediaSession.metadata = metadata;
    }
  );

  watch(
    () => [playback.elapsedSeconds, playback.duration],
    () => {
      if (!navigator.mediaSession?.setPositionState) {
        return;
      }

      if (playback.elapsedSeconds >= playback.duration) {
        return;
      }

      navigator.mediaSession.setPositionState({
        position: playback.elapsedSeconds,
        duration: playback.duration,
        playbackRate: 1,
      });
    }
  );
}

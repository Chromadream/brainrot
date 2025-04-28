import { Innertube, YTNodes } from 'youtubei.js';

const youtube = await Innertube.create({ retrieve_player: false });

const playlist = await youtube.getPlaylist(
  "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M",
);

const lastUpdated = playlist.info.last_updated;

const items =
  (await Promise.all(
    playlist.items.slice(0,5).map(item => item.as(YTNodes.PlaylistVideo)).map((item) => youtube.music.getInfo(item.id)),
  ))
    .map((item) => item.basic_info)
    .map((item) => ({
    id: item.id,
    title: item.title,
    author: item.author,
    thumbnail: (item.thumbnail?.at(-2)?.url),
  }));
export { items, lastUpdated };

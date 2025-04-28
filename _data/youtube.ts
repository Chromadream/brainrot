import { Innertube, YTNodes } from 'youtubei.js';

const youtube = await Innertube.create({ retrieve_player: false });

const playlist = await youtube.getPlaylist(
  "PLbiAZv0qcXO0mJNjtJ4Gdjb_T6ZZUnD8M",
);

const lastUpdated = playlist.info.last_updated;

const temporary_items = await Promise.all(
  playlist.items.slice(0,5).map(item => item.as(YTNodes.PlaylistVideo)).map(async (item) => {
    try {
      const info = await youtube.music.getInfo(item.id);
      console.log(`Successfully retrieved info for ID ${item.id}`);
      return info;
    } catch (error) {
      console.error(`Failed to get info for ID ${item.id}:`, error);
      return null; // Or a placeholder object
    }
  })
);

const items = temporary_items
    .map((item) => item!.basic_info)
    .map((item) => ({
    id: item.id,
    title: item.title,
    author: item.author,
    thumbnail: (item.thumbnail?.at(-2)?.url),
  }));
export { items, lastUpdated };

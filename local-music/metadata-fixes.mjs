// Some downloaded compilations stamp the compiler's name into the tags ("调音工作室—成名曲") and,
// for one of them, the artist into the title. Their file names are right, so for those files the
// identity comes from the name. Each compilation orders the name differently.
const COMPILER = /调音工作室|深度音乐工作室/;
const RULES = [
  { folder: /成名曲/, order: "title-artist" },   // 2701.向天再借五百年-韩磊.mp3
  { folder: /榜单/, order: "artist-title" },     // 0236潘玮柏_张韶涵-快乐崇拜.mp3
];

export function fixIdentity(relativePath, title, artist) {
  if (!COMPILER.test(String(artist || ""))) return { title, artist };
  const rule = RULES.find((item) => item.folder.test(relativePath));
  const stem = relativePath.split("/").pop().replace(/\.[^.]+$/, "").replace(/^\d+[.\s]*/, "");
  const separator = stem.includes(" - ") ? " - " : "-";
  const index = stem.indexOf(separator);
  if (!rule || index < 0) return { title, artist };
  const first = stem.slice(0, index).trim();
  const second = stem.slice(index + separator.length).trim();
  const [cleanTitle, cleanArtist] = rule.order === "title-artist" ? [first, second] : [second, first];
  return { title: cleanTitle || title, artist: cleanArtist.replace(/_/g, "&") || artist };
}

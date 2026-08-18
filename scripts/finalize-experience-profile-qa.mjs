import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(resolve("local-music/music-library.sqlite"));
const fixes = new Map([
  [528, { style:["华语流行R&B","弦乐抒情","大副歌情歌"], identity:"钢琴与弦乐托住克制主歌，副歌把执着推成宽阔痛感，深情里有明显的挽回力度。" }],
  [685, { style:["当代流行","流行R&B","浪漫抒情"], felt:["沉浸式爱意","温柔","热烈但不躁动","安心"], energy:["中速平稳推进","副歌自然抬升","保持顺滑高位"], sound:["顺滑男声","柔和电子节拍","层叠和声","流行弦乐"], identity:"顺滑R&B律动与几乎窒息般的热烈告白结合，亲密、饱满，却不是舞曲式高嗨。", avoid:"不适合夜店强拍、愤怒宣泄、暗黑危险或低人声背景需求。" }],
  [703, { identity:"钢琴主导的克制等待逐步扩张成大副歌，怀念和坚定比绝望更突出。" }],
  [826, { identity:"轻柔民谣编曲与近距离女声营造安静归属感，怀旧中有微凉，但不沉重。" }],
  [926, { identity:"轻声民谣把长大后的失落保持在低位，像不愿离开童年却无法真正回去的温柔下沉。" }],
  [1035, { identity:"男子组合和声把温柔承诺唱得饱满而整齐，适合仪式感浪漫，没有苦情拉扯。" }],
  [1172, { style:["励志嘻哈","硬派流行说唱","大副歌说唱"], felt:["坚定","对抗","自我救赎","振奋"], energy:["说唱持续增压","副歌集体抬升","结尾保持胜利姿态"], sound:["重拍鼓组","密集说唱","层叠合唱副歌","厚重合成器"], identity:"强硬说唱与万人合唱式副歌把脆弱转成公开宣言，核心体验是迎面反击而非温柔疗愈。", avoid:"不适合安静陪伴、轻柔恋爱、松弛背景或不想听密集说唱的需求。" }],
  [1228, { identity:"管弦乐的缓慢展开让告别显得庄重而沉重，重点是电影化的余韵，不是副歌宣泄。" }],
  [1274, { identity:"粗粝布鲁斯吉他和强硬鼓组把关系中的苦涩推向外放对抗，是老鹰乐队少见的硬朗攻击面。" }],
  [1301, { identity:"四拍节奏与循环钩子制造稳定舞池催眠感，重点是身体律动而不是情绪叙事。" }],
  [1335, { identity:"柔和乡村摇滚与标志性和声包住微妙失落，听感温暖流畅，却隐含被取代的不安。" }],
  [1351, { style:["放克流行","流行R&B","低音驱动流行"], felt:["自信","挑衅","暧昧","轻微不耐烦"], energy:["低音律动稳定推进","副歌钩子强化","全程克制而有弹性"], sound:["强辨识度贝斯线","干净鼓机","近距离男声","简洁合成器"], identity:"贝斯钩子与克制男声把暧昧变成一种冷静挑衅，酷和律动比深情更突出。", avoid:"不适合沉重催泪、宏大摇滚、纯真甜蜜或低存在感背景需求。" }],
  [1418, { identity:"快速说唱、808鼓点和轻巧押韵构成聪明又张扬的胜利姿态，活力大于攻击性。" }],
  [1471, { identity:"现场人声与乐队逐步抬升出温暖的坚定感，希望来自共同唱响，而非空泛的轻快。" }],
  [1488, { energy:["节奏跳跃推进","段落切换明显","副歌钩子强化"], identity:"多变段落、电子鼓和俏皮演唱制造跳跃游戏感，轻盈变化本身就是核心乐趣。" }],
  [1522, { identity:"强劲吉他与紧迫鼓点把粤语流行推向直接反抗，粗粝力量明显超过浪漫成分。" }],
  [1547, { identity:"清亮女声、轻快鼓点和甜味旋律组成无压力的青春悍动，俏皮大于缠绵。" }],
]);

const get = db.prepare("SELECT t.title,t.artist,p.* FROM tracks t JOIN song_experience_profiles p ON p.track_id=t.id WHERE t.id=?");
const matching = db.prepare("SELECT id FROM tracks WHERE available=1 AND lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?))");
const update = db.prepare(`UPDATE song_experience_profiles SET style_json=?,felt_json=?,energy_json=?,sound_json=?,identity_text=?,avoid_text=?,notes='bulk-all-v1-codex-qa',updated_at=CURRENT_TIMESTAMP WHERE track_id=? AND source='llm_bulk_draft'`);
const copy = db.prepare(`INSERT INTO song_experience_profiles (track_id,style_json,felt_json,energy_json,sound_json,identity_text,avoid_text,source,review_status,notes)
  VALUES (?,?,?,?,?,?,?,?,?,'logical-duplicate-propagation') ON CONFLICT(track_id) DO NOTHING`);

db.exec("BEGIN");
try {
  for (const [id, fix] of fixes) {
    const row=get.get(id); if(!row) continue;
    for(const target of matching.all(row.title,row.artist)) update.run(
      JSON.stringify(fix.style || JSON.parse(row.style_json)), JSON.stringify(fix.felt || JSON.parse(row.felt_json)),
      JSON.stringify(fix.energy || JSON.parse(row.energy_json)), JSON.stringify(fix.sound || JSON.parse(row.sound_json)),
      fix.identity || row.identity_text, fix.avoid || row.avoid_text, target.id,
    );
  }
  const missing=db.prepare(`SELECT t.id,t.title,t.artist FROM tracks t LEFT JOIN song_experience_profiles p ON p.track_id=t.id WHERE t.available=1 AND p.track_id IS NULL`).all();
  for(const target of missing){
    const donor=db.prepare(`SELECT p.* FROM tracks t JOIN song_experience_profiles p ON p.track_id=t.id WHERE t.available=1 AND t.id<>? AND lower(trim(t.title))=lower(trim(?)) AND lower(trim(t.artist))=lower(trim(?)) LIMIT 1`).get(target.id,target.title,target.artist);
    if(donor) copy.run(target.id,donor.style_json,donor.felt_json,donor.energy_json,donor.sound_json,donor.identity_text,donor.avoid_text,donor.source,donor.review_status);
  }
  db.exec("COMMIT");
} catch(error){db.exec("ROLLBACK");throw error;}
db.exec("PRAGMA optimize");
console.log(`Codex QA finalized ${fixes.size} profiles and propagated exact logical duplicates.`);

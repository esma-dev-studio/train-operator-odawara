/* =========================================================
 * ui/badges.js — くんしょう(実績)。運転のいろいろな「できた！」を記録する
 * ========================================================= */
export const BADGES = [
  { id: 'first', icon: '初', name: 'はじめての うんてん', desc: 'ゴールまで はしった' },
  { id: 'perfect', icon: '◎', name: 'ぴったり！', desc: '「8」に ぴったり とめた' },
  { id: 'perfect10', icon: '名', name: 'ぴったり めいじん', desc: 'ぴったりを 10かい' },
  { id: 'perfect30', icon: '達', name: 'ぴったり たつじん', desc: 'ぴったりを 30かい' },
  { id: 'safe', icon: '安', name: 'あんぜん うんてん', desc: 'じどうブレーキ 0かいで ゴール(3えき いじょう)' },
  { id: 'ontime', icon: '時', name: 'じかん ぴったり', desc: 'おくれ なしで ゴール(3えき いじょう)' },
  { id: 'fullDown', icon: '下', name: 'くだり ぜんぶ', desc: '新宿 → 新百合ヶ丘 を ぜんぶ はしった' },
  { id: 'fullUp', icon: '上', name: 'のぼり ぜんぶ', desc: '新百合ヶ丘 → 新宿 を ぜんぶ はしった' },
  { id: 'exp', icon: '急', name: 'きゅうこうの うんてんし', desc: '急行で ゴール' },
  { id: 'rapid', icon: '快', name: 'かいそくきゅうこうの うんてんし', desc: '快速急行で ゴール' },
  { id: 'evening', icon: '夕', name: 'ゆうやけの うんてんし', desc: 'ゆうがたに ゴール' },
  { id: 'night', icon: '夜', name: 'よるの うんてんし', desc: 'よるに ゴール' },
  { id: 'rain', icon: '雨', name: 'あめでも へっちゃら', desc: 'あめの日に ゴール' },
  { id: 'snow', icon: '雪', name: 'ゆきの日の うんてんし', desc: 'ゆきの日に ゴール' },
  { id: 'rankA', icon: 'A', name: 'めいじん うんてんし', desc: 'ランクA いじょう' },
  { id: 'rankS', icon: 'S', name: 'でんせつの うんてんし', desc: 'ランクS' },
  { id: 'stamp10', icon: '印', name: 'スタンプ あつめ', desc: 'えきスタンプを 10しゅるい' },
  { id: 'stampAll', icon: '全', name: 'スタンプ コンプリート', desc: '23えき ぜんぶの スタンプ' },
  { id: 'horn', icon: '笛', name: 'けいてき', desc: 'けいてきを ならした' },
  { id: 'camera', icon: '視', name: 'カメラマン', desc: 'してんを ぜんぶ ためした' },
];

export const badgeById = (id) => BADGES.find((b) => b.id === id);

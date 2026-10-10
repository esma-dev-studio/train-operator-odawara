/* =========================================================
 * ui/badges.js — くんしょう(実績)。運転のいろいろな「できた！」を記録する
 * icon は ui/icons.js のピクトグラム名(漢字1文字のマークは小2に読めないのでやめた)。
 * ランクのくんしょうだけは letter('S'/'A')を そのまま出す。
 * ========================================================= */
export const BADGES = [
  { id: 'first', icon: 'flag', name: 'はじめての うんてん', desc: 'ゴールまで はしった' },
  { id: 'perfect', icon: 'target', name: 'ぴったり！', desc: '「8」に ぴったり とめた' },
  { id: 'perfect10', icon: 'medal', name: 'ぴったり めいじん', desc: 'ぴったりを 10かい' },
  { id: 'perfect30', icon: 'trophy', name: 'ぴったり たつじん', desc: 'ぴったりを 30かい' },
  { id: 'safe', icon: 'shield', name: 'あんぜん うんてん', desc: 'じどうブレーキ 0かいで ゴール(3えき いじょう)' },
  { id: 'ontime', icon: 'clock', name: 'じかん ぴったり', desc: 'おくれ なしで ゴール(3えき いじょう)' },
  { id: 'fullDown', icon: 'route-down', name: 'くだり ぜんぶ', desc: '<ruby>新宿<rt>しんじゅく</rt></ruby> → <ruby>新百合ヶ丘<rt>しんゆりがおか</rt></ruby> を ぜんぶ はしった' },
  { id: 'fullUp', icon: 'route-up', name: 'のぼり ぜんぶ', desc: '<ruby>新百合ヶ丘<rt>しんゆりがおか</rt></ruby> → <ruby>新宿<rt>しんじゅく</rt></ruby> を ぜんぶ はしった' },
  { id: 'exp', icon: 'train', name: 'きゅうこうの うんてんし', desc: '<ruby>急行<rt>きゅうこう</rt></ruby>で ゴール' },
  { id: 'rapid', icon: 'fast', name: 'かいそくきゅうこうの うんてんし', desc: '<ruby>快速急行<rt>かいそくきゅうこう</rt></ruby>で ゴール' },
  { id: 'evening', icon: 'sunset', name: 'ゆうやけの うんてんし', desc: 'ゆうがたに ゴール' },
  { id: 'night', icon: 'moon', name: 'よるの うんてんし', desc: 'よるに ゴール' },
  { id: 'rain', icon: 'rain', name: 'あめでも へっちゃら', desc: 'あめの日に ゴール' },
  { id: 'snow', icon: 'snow', name: 'ゆきの日の うんてんし', desc: 'ゆきの日に ゴール' },
  { id: 'rankA', letter: 'A', name: 'めいじん うんてんし', desc: 'ランクA いじょう' },
  { id: 'rankS', letter: 'S', name: 'でんせつの うんてんし', desc: 'ランクS' },
  { id: 'stamp10', icon: 'stamp', name: 'スタンプ あつめ', desc: 'えきスタンプを 10しゅるい' },
  { id: 'stampAll', icon: 'book', name: 'スタンプ コンプリート', desc: '23えき ぜんぶの スタンプ' },
  { id: 'horn', icon: 'horn', name: 'けいてき', desc: 'けいてきを ならした' },
  { id: 'camera', icon: 'camera', name: 'カメラマン', desc: 'してんを ぜんぶ ためした' },
];

export const badgeById = (id) => BADGES.find((b) => b.id === id);

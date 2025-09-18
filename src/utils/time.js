'use strict';

function nowEpoch(){
  return Math.floor(Date.now()/1000);
}

function ymdFromEpoch(sec){
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function ymdToday(){
  return ymdFromEpoch(nowEpoch());
}

function ymdYesterday(){
  return ymdFromEpoch(nowEpoch() - 86400);
}

function dayHeadingFromEpoch(sec){
  const ymd = ymdFromEpoch(sec);
  if (ymd === ymdToday()) return 'Today';
  if (ymd === ymdYesterday()) return 'Yesterday';
  return new Date(sec * 1000).toLocaleDateString();
}

module.exports = {
  nowEpoch,
  ymdFromEpoch,
  ymdToday,
  ymdYesterday,
  dayHeadingFromEpoch,
};

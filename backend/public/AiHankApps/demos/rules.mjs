export function dispatch({site,staff,plan,conclusion,consents}) {
 const errors=[];
 if(site!=='ground')errors.push('地下室核准為0；只能使用容量12人的地面主室。');
 if(conclusion!=='scope')errors.push('現有資料只能反駁零使用，不能證明收賄。');
 if(!['A','B'].includes(plan))errors.push('先選一個方案。');
 if(plan==='A'&&(staff[0]!=='hall'||staff[1]!=='classroom'))errors.push('兩地須各有一位全程值班員；不可重複排班。');
 if(plan==='B'&&(staff.filter(x=>x==='hall').length!==1||staff.filter(x=>x==='standby').length!==1))errors.push('乙方案只開主室：一位值班員，另一位待命；不可排到未開放教室。');
 if(!consents?.every(Boolean)||consents.length!==3)errors.push('須確認支出、場地上限與未服務者／翌日取消的告知。');
 return {errors,ok:!errors.length,tonight:plan==='A'?18:12,tomorrow:plan==='A'?0:8,spent:plan==='A'?2:1,reserved:plan==='B'?1:0,balance:0};
}
export function bench({speed,hood,wires,jamRemoved}){
 const fast=speed==='fast',noise=fast?(hood?35:55):36,load=fast?8:6,seconds=fast?1.2:2.4,slots=4+(hood?1:0),weight=fast?(hood?10:8):(hood?10:8);const errors=[];
 if(!['slow','fast'].includes(speed))errors.push('請安裝一個送料組。');
 if(!wires?.[0])errors.push('踏板輸出尚未接到印字匣觸發輸入。');
 if(!wires?.[1])errors.push('印字匣送料輸出尚未接到送料組啟動輸入。');
 if(!jamRemoved)errors.push('出紙口擋片造成卡紙；移除後可在同一教學格修正。');
 if(noise>40)errors.push('聲量55超過40；改用慢速組或加隔音罩。');
 return {ok:!errors.length,errors,noise,load,seconds,slots,weight};
}
export function rehearsal({clearExit,pace}){const errors=[];if(!clearExit)errors.push('出口被阻擋，不能開放。');if(pace==='long')errors.push('留白過長，僅1/3測試者完成；至少需2位。');const finished=pace==='balanced'?3:pace==='short'?2:1;return {ok:!errors.length,errors,finished,revenue:finished===3?90:60};}

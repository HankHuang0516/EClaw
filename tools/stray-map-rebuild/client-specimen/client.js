'use strict';
// NON-FORMAL, READ-ONLY CLIENT SPECIMEN. No login, device identity, mutation, geocoding or map coordinates.
const TEXT={
 'zh-TW':{title:'非正式客戶端試件',notice:'這不是浪浪地圖 App，也未連接正式環境。',reload:'重新讀取',loading:'讀取中',ready:'已審核區域線索',unavailable:'資料來源中斷：卡片已隱藏，數量未知。',layer:'位置圖層',noPoint:'沒有核准可信點位，圖層未啟用。',LOST:'走失 · 最後已知區域',FOUND:'拾獲 · 拾獲區域',SIGHTING:'來源目擊 · 觀察區域',UNSPECIFIED_LEGACY:'類型未指定',third:'第三方公開線索，非本人目擊',time:'來源觀察時點',care:'來源記載照管狀態',asOf:'照管記載時點',unknown:'未知',IN_CARE:'照管中',NOT_IN_CARE:'未照管',UNKNOWN:'未知',share:'開啟分享'},
 en:{title:'Non-formal client specimen',notice:'This is not the Stray Map App and is not connected to production.',reload:'Refresh',loading:'Loading',ready:'Reviewed region leads',unavailable:'Source unavailable: cards hidden; count unknown.',layer:'Location layer',noPoint:'No approved trusted point was supplied; the layer is inactive.',LOST:'Lost · last known region',FOUND:'Found · found region',SIGHTING:'Source sighting · observed region',UNSPECIFIED_LEGACY:'Unspecified report',third:'Third-party public lead; not self-witnessed',time:'Source observation time',care:'Source-reported care',asOf:'Care report time',unknown:'Unknown',IN_CARE:'In care',NOT_IN_CARE:'Not in care',UNKNOWN:'Unknown',share:'Open share'},
 'zh-CN':{title:'非正式客户端试件',notice:'这不是浪浪地图 App，也未连接正式环境。',reload:'重新读取',loading:'读取中',ready:'已审核区域线索',unavailable:'数据来源中断：卡片已隐藏，数量未知。',layer:'位置图层',noPoint:'没有获准可信点位，图层未启用。',LOST:'走失 · 最后已知区域',FOUND:'拾获 · 拾获区域',SIGHTING:'来源目击 · 观察区域',UNSPECIFIED_LEGACY:'类型未指定',third:'第三方公开线索，非本人目击',time:'来源观察时点',care:'来源记载照管状态',asOf:'照管记载时点',unknown:'未知',IN_CARE:'照管中',NOT_IN_CARE:'未照管',UNKNOWN:'未知',share:'打开分享'},
 ja:{title:'非公式クライアント試験用',notice:'これはStray Mapアプリではなく、本番環境に接続しません。',reload:'再読込',loading:'読込中',ready:'審査済みの地域情報',unavailable:'情報源が利用できません。カードを非表示にし、件数は不明です。',layer:'位置レイヤー',noPoint:'承認された信頼できる地点がないため、レイヤーは無効です。',LOST:'迷子 · 最後に確認された地域',FOUND:'保護 · 発見地域',SIGHTING:'情報源の目撃 · 目撃地域',UNSPECIFIED_LEGACY:'種類不明',third:'第三者の公開情報・本人の目撃ではありません',time:'情報源の観察時刻',care:'情報源が報告した保護状況',asOf:'保護状況の報告時刻',unknown:'不明',IN_CARE:'保護中',NOT_IN_CARE:'保護していない',UNKNOWN:'不明',share:'共有ページ'},
 ko:{title:'비공식 클라이언트 시험용',notice:'Stray Map 앱이 아니며 운영 환경에 연결되지 않습니다.',reload:'새로고침',loading:'불러오는 중',ready:'검토된 지역 제보',unavailable:'출처를 사용할 수 없습니다. 카드를 숨기며 개수는 알 수 없습니다.',layer:'위치 레이어',noPoint:'승인된 신뢰할 수 있는 지점이 없어 레이어가 비활성화되었습니다.',LOST:'실종 · 마지막으로 알려진 지역',FOUND:'발견 · 발견 지역',SIGHTING:'출처의 목격 · 목격 지역',UNSPECIFIED_LEGACY:'유형 미지정',third:'제3자 공개 제보이며 직접 목격이 아닙니다',time:'출처의 관찰 시간',care:'출처가 보고한 보호 상태',asOf:'보호 보고 시간',unknown:'알 수 없음',IN_CARE:'보호 중',NOT_IN_CARE:'보호하지 않음',UNKNOWN:'알 수 없음',share:'공유 열기'}
};
const QUALITY={en:['Partial source coverage','Source coverage unknown'],'zh-TW':['部分來源暫時缺漏','來源涵蓋範圍未知'],'zh-CN':['部分来源暂时缺漏','来源覆盖范围未知'],ja:['一部の情報源が欠落しています','情報源の範囲は不明です'],ko:['일부 출처가 누락되었습니다','출처 범위를 알 수 없습니다']};
const requested=new URL(location.href).searchParams.get('lang'),locale=Object.hasOwn(TEXT,requested)?requested:'zh-TW';
const i18n={t:key=>TEXT[locale][key]};
document.documentElement.lang=locale;document.title=i18n.t('title');for(const[id,key]of [['title','title'],['notice','notice'],['reload','reload'],['layer-title','layer'],['layer-status','noPoint']])document.getElementById(id).textContent=i18n.t(key);
const state={nonFormal:true,readOnly:true,appUIVerified:false,pins:0,coordinates:[],requests:0,visible:[],status:'LOADING'};window.__CLIENT_SPECIMEN__=state;
let generation=0,activeRequest;
const element=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
const date=value=>value?.precision==='UNKNOWN'?i18n.t('unknown'):`${value.value} (${value.timeZone})`;
function render(lead){
    if(lead.origin!=='EXTERNAL_PUBLIC_LEAD'||lead.selfWitness!==false||lead.location?.coordinates!==null||lead.mapMarkerEligible!==false)throw Error('UNAPPROVED_LOCATION_CONTRACT');
    const card=element('article',undefined,'lead-card');card.dataset.id=lead.id;card.dataset.locale=lead.display.locale;card.lang=lead.display.locale;
    card.append(element('p',i18n.t(lead.report.type)||i18n.t('UNSPECIFIED_LEGACY'),'tag'),element('h2',lead.display.title),element('p',lead.display.description),element('p',i18n.t('third')));
    const region=element('p',`${lead.location.countryCode} · ${lead.location.regionCode||i18n.t('unknown')}`,'coarse');region.dataset.location='REGION';card.append(region);
    const time=element('p',`${i18n.t('time')}: ${date(lead.observation)}`);time.dataset.precision=lead.observation.precision;card.append(time);
    card.append(element('p',`${i18n.t('care')}: ${i18n.t(lead.report.custody.status)||i18n.t('unknown')}`),element('p',`${i18n.t('asOf')}: ${date(lead.report.custody.asOf)}`));
    for(const photo of lead.photos){const url=new URL(photo.url,location.origin);if(url.origin!==location.origin||!url.pathname.startsWith('/external-media/'))throw Error('UNAPPROVED_PHOTO_ORIGIN');
        const figure=element('figure'),image=element('img');image.src=url.href;image.alt=photo.caption;figure.append(image,element('figcaption',photo.caption));card.append(figure);}
    const share=element('a',i18n.t('share'));share.href=`/a/${encodeURIComponent(lead.id)}`;card.append(share);return card;
}
async function refresh(){
    const own=++generation;if(activeRequest)activeRequest.abort();activeRequest=new AbortController();
    const container=document.getElementById('leads'),status=document.getElementById('status'),count=document.getElementById('count');status.textContent=i18n.t('loading');state.status='LOADING';
    try{state.requests++;const response=await fetch('/v1/animals?view=external-origin-v1',{cache:'no-store',redirect:'error',signal:activeRequest.signal});if(own!==generation)return;if(!response.ok)throw Error('API_UNAVAILABLE');const body=await response.json();if(own!==generation)return;
        if(body.success!==true||body.view!=='external-origin-v1'||body.nativeIncluded!==false||!Array.isArray(body.externalLeads)||!Array.isArray(body.mapMarkers)||body.mapMarkers.length)throw Error('INVALID_EXTERNAL_VIEW');
        const quality=body.dataQuality?.sourceAvailability||'UNKNOWN';if(quality==='UNAVAILABLE')throw Error('SOURCE_UNAVAILABLE');
        const cards=body.externalLeads.map(render);container.replaceChildren(...cards);state.visible=body.externalLeads.map(lead=>lead.id);state.status='AVAILABLE';state.sourceAvailability=quality;
        status.className='';status.textContent=i18n.t('ready')+(quality==='PARTIAL'?` · ${QUALITY[locale][0]}`:quality==='UNKNOWN'?` · ${QUALITY[locale][1]}`:'');count.textContent=String(cards.length);
    }catch{if(own!==generation)return;container.replaceChildren();state.visible=[];state.status='UNAVAILABLE';status.className='error';status.textContent=i18n.t('unavailable');count.textContent='—';}
}
document.getElementById('reload').addEventListener('click',refresh);refresh();

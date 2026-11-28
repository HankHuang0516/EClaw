'use strict';
const { validateTip } = require('../stray-map-intake/contract');
const VIEW = 'external-origin-v1';
const exact = (value,keys) => value && typeof value==='object' && !Array.isArray(value)
    && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
// A conservative extra gate, not a substitute for the required manual privacy/safety review.
const privateText = value => /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|@[a-z\d_]{2,}|\+?\d[\d ()-]{7,}\d|\d{1,3}\.\d{3,}\s*[,，]\s*-?\d{1,3}\.\d{3,})/i.test(value.replace(/\b\d{4}-\d{2}-\d{2}\b/g,''));
function validatePublicContent(content,payload,{submittedAt,sourcePolicy,verifiedUploads}) {
    if(!exact(content,['locale','title','description','photoCaptions']) || content.locale!==payload.display.locale
        || !Array.isArray(content.photoCaptions) || content.photoCaptions.length!==payload.photos.length
        || content.photoCaptions.some((item,index)=>!exact(item,['uploadId','caption'])||item.uploadId!==payload.photos[index].uploadId)
        || [content.title,content.description,...content.photoCaptions.map(p=>p.caption)].some(v=>typeof v!=='string'||privateText(v)))
        return {success:false,error:'INVALID_PUBLIC_CONTENT',status:403};
    const publicPayload={...payload,display:{locale:content.locale,title:content.title,description:content.description},
        photos:payload.photos.map((photo,index)=>({...photo,caption:content.photoCaptions[index].caption}))};
    const valid=validateTip(Buffer.from(JSON.stringify(publicPayload)),{submittedAt,sourcePolicy,verifiedUploads});
    return valid.success?{success:true,content:structuredClone(content)}:{success:false,error:'INVALID_PUBLIC_CONTENT',status:403};
}
function publicContent(payload) {return {...payload.display,photoCaptions:payload.photos.map(p=>({uploadId:p.uploadId,caption:p.caption}))};}
function isUuid(value) {return typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);}
function photoUuid(uploadId) {const hex=uploadId.slice(3);return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');}
module.exports={VIEW,validatePublicContent,publicContent,privateText,isUuid,photoUuid};

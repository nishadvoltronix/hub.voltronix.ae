import type { ZohoInboundDeal, ZohoInboundNote, ZohoInboundProduct } from "./inbound-snapshot.js";

export type ZohoInboundProjection = Record<string,string|number|null>;
/** Three-way merge only of explicitly source-owned fields. Missing remote fields
 * retain local values, and a local change since the last applied source is not
 * silently overwritten. Null is a real observed source value. */
export function mergeZohoInboundProjection(current:ZohoInboundProjection,incoming:ZohoInboundProjection,baseline:ZohoInboundProjection|null) {
  const projection:ZohoInboundProjection={};
  for(const [key,value] of Object.entries(incoming)) {
    if(baseline && Object.hasOwn(baseline,key) && current[key]!==baseline[key] && current[key]!==value) return {conflict:true as const};
    projection[key]=value;
  }
  return {conflict:false as const,projection,changed:Object.entries(projection).some(([key,value])=>current[key]!==value)};
}
const localDecimal=/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;
export function inboundProductProjection(value:ZohoInboundProduct):ZohoInboundProjection|undefined {
  if(value.name.length>255 || value.unitPrice!==null && !localDecimal.test(value.unitPrice))return undefined;
  return {product_name:value.name,...(!value.missingOptionalFields.includes("Description")?{description:value.description}:{}),
    ...(!value.missingOptionalFields.includes("Unit_Price")?{unit_price:value.unitPrice}:{})};
}
export function inboundDealProjection(value:ZohoInboundDeal,assigned:string|null):ZohoInboundProjection|undefined {
  if(value.amount!==null && (!localDecimal.test(value.amount)||value.amount.startsWith("-")))return undefined;
  const fields:Record<string,[string,string|null]>={
    VZ_app_user:["assigned_to",assigned],Owner:["owner_id",value.owner?.externalId??null],Account_Name:["account_name",value.account?.name??null],
    Contact_Name:["customer_name",value.contact?.name??null],Email:["customer_email",value.email],Phone:["customer_contact",value.phone],
    Address:["address",value.address],Description:["complaint_info",value.description],DealNumber:["deal_number",value.dealNumber],
    EnquiryNumber:["enq_number",value.enquiryNumber],QualDealNumber:["qual_deal_number",value.qualificationNumber],SiteDealNumber:["site_deal_number",value.siteNumber],
    QuoteDealNumber:["quote_deal_number",value.quotationNumber],JobDealNumber:["job_deal_number",value.jobNumber],LostDealNumber:["lost_deal_number",value.lostNumber],
    Qualified_Time:["qual_deal_date",value.qualificationDate],Site_Deal_Date:["site_deal_date",value.siteDate],Quote_Date:["quote_deal_date",value.quotationDate],
    Job_Date:["job_deal_date",value.jobDate],Lost_Time:["lost_deal_date",value.lostDate],Amount:["service_charge",value.amount],P_BOX:["p_box",value.poBox],TRN:["trn",value.trn],
  };
  const status=value.stage==="Qualification" && [null,"Pending","Qualification"].includes(value.applicationStatus)?"Pending":
    value.stage==="Needs Analysis" && [null,"Site Visit"].includes(value.applicationStatus)?"Site Visit":value.stage;
  const result:ZohoInboundProjection={deal_name:value.name,status};
  for(const [remote,[local,content]] of Object.entries(fields))if(!value.missingOptionalFields.includes(remote))result[local]=content;
  return result;
}
export function inboundNoteProjection(value:ZohoInboundNote):ZohoInboundProjection|undefined {
  if(value.missingOptionalFields.includes("Note_Title")||value.missingOptionalFields.includes("Note_Content"))return undefined;
  return {note_title:value.title??"",note_content:value.content??""};
}

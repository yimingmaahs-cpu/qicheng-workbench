export type PetChatReply={request:string;role:string;conversation:string;text:string;status:string};
export type PetChatSnapshot={role:string;name:string;conversation:string;hasKey:boolean;user:string;reply:{request?:string;text:string;status:string}|null;busy:{request:string;conversation:string;role:string}|null;warning:string};
export type PetChatEvent={type:'state';state:PetChatSnapshot}|{type:'delta';role:string;conversation:string;text:string}|{type:'focus'};
export type PetChatCommand={type:'read'}|{type:'send';role:string;conversation:string;text:string}|{type:'stop';request:string}|{type:'close'}|{type:'panel'}|{type:'layout';height:number};
export type PetChatAPI={command:(command:PetChatCommand)=>Promise<any>;onEvent:(callback:(event:PetChatEvent)=>void)=>()=>void};

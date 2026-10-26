import {useLayoutEffect,useRef} from 'react';
import type {RefObject} from 'react';

let pointerTrigger:HTMLElement|null=null;
const openers=new WeakMap<HTMLDialogElement,HTMLElement>();
export function rememberDialogTrigger(target:Element|null){pointerTrigger=target instanceof HTMLElement?target:null}
export function clearDialogTrigger(){pointerTrigger=null}
function visibleOpener(target:HTMLElement|null):HTMLElement|null {
  for(let depth=0;target&&depth<8;depth++){
    const parent=target.closest('dialog');
    if(!parent||parent.open)return target;
    target=openers.get(parent)||null;
  }
  return null;
}
// Safari pointer clicks need an explicit return target. Keep native modal focus
// containment and resolve a closed parent when moving between training sheets.
export function useTrainingDialog(ref:RefObject<HTMLDialogElement|null>,open:boolean,onOpen?:()=>void){
  const restore=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{
    const dialog=ref.current;if(!dialog)return;
    if(open&&!dialog.open){
      const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;
      restore.current=visibleOpener(pointerTrigger||focused);
      if(restore.current)openers.set(dialog,restore.current);
      clearDialogTrigger();onOpen?.();dialog.showModal();
    } else if(!open&&restore.current){
      if(dialog.open)dialog.close();
      const target=visibleOpener(restore.current);restore.current=null;
      if(target?.isConnected&&target.getClientRects().length)target.focus({preventScroll:true});
      clearDialogTrigger();
    }
    // onOpen only initializes a draft on the closed-to-open edge.
  },[ref,open]);
}

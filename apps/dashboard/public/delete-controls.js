(() => {
  function addDeleteControls(){
    const heading=(document.querySelector('h1')?.textContent||'').trim().toLowerCase();
    if(heading!=='devices'&&heading!=='branches') return;
    document.querySelectorAll('button').forEach(button=>{
      const label=(button.textContent||'').trim();
      if(label!=='Deactivate') return;
      const parent=button.parentElement;
      if(!parent||parent.querySelector('.attendra-delete-btn')) return;
      const del=document.createElement('button');
      del.type='button';
      del.className='attendra-delete-btn';
      del.textContent='Delete';
      del.style.cssText='margin-left:8px;padding:9px 14px;border:1px solid #dc2626;border-radius:10px;background:#fff;color:#b91c1c;font:inherit;cursor:pointer';
      del.onclick=()=>{
        const row=parent.parentElement;
        const name=(row?.querySelector('strong')?.textContent||row?.firstElementChild?.textContent||'this item').trim();
        const kind=heading==='devices'?'tablet':'branch';
        const ok=confirm('Delete '+kind+' "'+name+'" from active use?\n\nHistorical attendance and audit records will be preserved.');
        if(!ok) return;
        button.click();
        window.setTimeout(()=>{
          const current=(button.textContent||'').trim();
          if(current==='Reactivate'&&row){row.style.display='none';alert((kind==='tablet'?'Tablet':'Branch')+' deleted from active use. Historical records were preserved.');}
        },700);
      };
      parent.appendChild(del);
    });
  }
  const observer=new MutationObserver(addDeleteControls);
  observer.observe(document.documentElement,{subtree:true,childList:true});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addDeleteControls);else addDeleteControls();
})();

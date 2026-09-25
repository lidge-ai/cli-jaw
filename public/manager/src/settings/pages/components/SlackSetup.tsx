import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {SettingsClient} from '../../types';
import {advance,applyValidation,blockerForStep,canAdvance,createFlow,fieldsFor,goBack,ISSUER_URLS,
    markSaved,markSlackIssuerOpened,markSlackManifestGenerated,resetSlackSetup,setField,
    settingsPatch,validationPayload,type OnboardChannel} from '../../../../../js/features/channel-onboarding-flow.js';
import {copyText} from '../../../../../js/features/copy-text.js';
import koJson from '../../../../../locales/ko.json';
import enJson from '../../../../../locales/en.json';
import jaJson from '../../../../../locales/ja.json';
import zhJson from '../../../../../locales/zh.json';
// JSON modules are shared by the Vite bundle and the component test runner.
const ko:Record<string,string>=koJson, en:Record<string,string>=enJson,
    ja:Record<string,string>=jaJson, zh:Record<string,string>=zhJson;
type Text=(key:string,params?:Record<string,unknown>)=>string;
export function slackText(locale:string): Text {
    const dictionaries:Record<string,Record<string,string>>={ko,en,ja,zh};
    const dict=dictionaries[locale] ?? ko;
    return (key,params={})=>Object.entries(params).reduce((text,[k,v])=>text.replaceAll(`{${k}}`,String(v)),dict[key] ?? ko[key] ?? key);
}
type Props={client:SettingsClient;t:Text;initialDraft:Record<string,string>;returnFocus:HTMLElement|null;onBeforeSave:()=>()=>Promise<void>;onClose:()=>void};
export function SlackSetup(props: Props) {
    return <ChannelSetupDialog {...props} channel="slack" />;
}
export function ChannelSetupDialog({channel,client,t,initialDraft,returnFocus,onBeforeSave,onClose}:Props & {channel:OnboardChannel}) {
    const [flow,setFlow]=useState(()=>createFlow(channel,initialDraft));
    const [name,setName]=useState('cli-jaw'), [busy,setBusy]=useState(false);
    const [error,setError]=useState<string|null>(null), [manifestStatus,setManifestStatus]=useState('');
    const dialog=useRef<HTMLDialogElement>(null), active=useRef(false), flight=useRef(false);
    useLayoutEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
    useEffect(()=>{
        const modal=dialog.current;
        modal?.showModal();
        return()=>{
            modal?.close();
            // The parent fieldset must be enabled before restoring its trigger.
            queueMicrotask(()=>{if(returnFocus?.isConnected)returnFocus.focus();});
        };
    },[returnFocus]);
    function close() { if(channel!=='slack' && flight.current)return; if(!flow.saved && !window.confirm('Discard unsaved changes?'))return; onClose(); }
    async function run(action:()=>Promise<void>, failureKey='onboarding.error.network') {
        if(flight.current)return;flight.current=true;setBusy(true);setError(null);
        try { await action(); } catch {if(active.current)setError(t(failureKey));}
        finally {flight.current=false;if(active.current)setBusy(false);}
    }
    async function manifest() {
        const appName=name.trim();
        if(!appName || Array.from(appName).length>35){setError(t('onboarding.slackAppNameError'));return;}
        await run(async()=>{
            const response=await client.get<{json?:string;botDisplayName?:string;data?:{json?:string;botDisplayName?:string}}>(`/api/slack/manifest?name=${encodeURIComponent(appName)}`);
            if(!active.current)return; const result=response.data ?? response;
            if(!result.json)throw new Error('manifest');
            const copied=await copyText(result.json);if(!copied.ok)throw new Error('clipboard');
            if(!active.current)return;
            setFlow(markSlackManifestGenerated);
            setManifestStatus(result.botDisplayName && result.botDisplayName!==appName
                ? t('onboarding.slackManifestCopiedWithBot',{bot:result.botDisplayName}) : t('onboarding.slackManifestReady'));
        }, 'onboarding.slackManifestError');
    }
    async function validate() {
        await run(async()=>{
            type Result=Parameters<typeof applyValidation>[1];
            const response=await client.post<Result & {data?:Result}>('/api/channels/validate',validationPayload(flow));
            if(active.current)setFlow(current=>applyValidation(current,response.data ?? response));
        });
    }
    async function save() {
        if(!flow.validatedIdentity || flow.saved)return;
        await run(async()=>{
            const complete=onBeforeSave(); // capture generation + dirty identities at PUT time
            await client.put('/api/settings',settingsPatch(flow));
            if(!active.current)return;
            await complete();if(active.current)setFlow(markSaved);
        });
    }
    function primaryAction() {
        if(busy || flight.current || flow.saved)return;
        if(flow.step===1 && channel==='slack'){void manifest();return;}
        if(flow.step===3){void validate();return;}
        if(flow.step===4){void save();return;}
        setFlow(advance);
    }
    return <dialog ref={dialog} className="settings-slack-setup" aria-labelledby="sl-setup-title"
        onCancel={event=>{event.preventDefault();close();}}
        onKeyDown={event=>{
            event.stopPropagation();
            if(event.key==='Enter' && !event.shiftKey && !event.nativeEvent.isComposing
                && event.target instanceof HTMLInputElement){event.preventDefault();primaryAction();}
        }}>
        <h2 id="sl-setup-title">{t(`onboarding.title.${channel}`)}</h2>
        <p role="status">{t('onboarding.progressLabel',{step:flow.step,total:4})}</p>
        <fieldset disabled={busy || flow.saved}>
            {flow.step===1 && channel==='slack' && <>
                <label htmlFor="sl-setup-name">{t('onboarding.slackAppName')}</label>
                <input id="sl-setup-name" value={name} onChange={event=>{setName(event.target.value);setFlow(resetSlackSetup);setManifestStatus('');}}/>
                <p>{t('onboarding.guide.slack')}</p>
                <button type="button" className="settings-action" onClick={()=>void manifest()}>{t('onboarding.slackGenerateManifest')}</button>
                <p role="status">{manifestStatus}</p>
                <button type="button" className="settings-action" disabled={flow.slackSetupStage==='manifest'} onClick={()=>{
                    window.open(ISSUER_URLS.slack,'_blank','noopener');setFlow(markSlackIssuerOpened);
                }}>{t('onboarding.openIssuer')}</button>
            </>}
            {flow.step===1 && channel!=='slack' && <>
                <p>{t(`onboarding.guide.${channel}`)}</p>
                <button type="button" className="settings-action" onClick={()=>window.open(ISSUER_URLS[channel],'_blank','noopener')}>{t('onboarding.openIssuer')}</button>
            </>}
            {flow.step===2 && fieldsFor(channel).map(field=><label key={field.key}>
                {t(`onboarding.token.${field.key}`)}{field.optional ? ` (${t('onboarding.optional')})` : ''}
                <input type={field.secret?'password':'text'} autoComplete="off" placeholder={field.example} value={flow.draft[field.key] ?? ''}
                    onChange={event=>setFlow(current=>setField(current,field.key,event.target.value))}/>
                <span>{t(`onboarding.hint.${channel}.${field.key}`)}</span>
            </label>)}
            {flow.step===3 && <>
                <button type="button" className="settings-action" onClick={()=>void validate()}>{t('onboarding.validate')}</button>
                {flow.validatedIdentity && <p>{t('onboarding.valid',{identity:flow.validatedIdentity})}</p>}
            </>}
            {flow.step===4 && <p>{t(flow.saved?`onboarding.next.${channel}`:'onboarding.saveHint')}</p>}
            {flow.step>1 && <button type="button" className="settings-action" onClick={()=>setFlow(goBack)}>{t('onboarding.back')}</button>}
            {flow.step<4 ? <button type="button" className="settings-action settings-action-save" disabled={!canAdvance(flow)} onClick={()=>setFlow(advance)}>{t('onboarding.next')}</button>
                : <button type="button" className="settings-action settings-action-save" disabled={!flow.validatedIdentity} onClick={()=>void save()}>{t('onboarding.save')}</button>}
        </fieldset>
        {(error || flow.error || (flow.step===2 && blockerForStep(flow))) && <p role="alert">{error ?? t(`onboarding.error.${flow.error ?? blockerForStep(flow)}`)}</p>}
        {!!flow.missingScopes.length && <p role="alert">{flow.missingScopes.join(', ')}</p>}
        {!!flow.missingCapabilities.length && <p role="status">{t('onboarding.warning.missingCapabilities',{capabilities:flow.missingCapabilities.join(', ')})}</p>}
        <button type="button" className="settings-action" disabled={channel!=='slack' && busy} onClick={close}>{t('onboarding.close')}</button>
    </dialog>;
}

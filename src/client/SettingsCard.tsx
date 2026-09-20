/**
 * The dsh-imagegen settings card: channel management (list rows with status
 * dots, an editor dialog with the model-catalog alias → upstream mapping, and
 * built-in provider presets), plus the prompt-enhancement model and the plugin
 * switches. Registers into the official `settings.plugin.item` slot (the
 * Settings → Plugins → Configurable tab), independent of the dsh-web-ui family
 * group, bound to the plugin's own bridge settings scope.
 *
 * The interaction mirrors the host's model-provider page: one row per channel
 * (status dot + edit/delete), two add buttons (built-in provider / custom),
 * and an editor holding API key, display name, API URL, and the model catalog
 * with detection.
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CardForm, booleanField, secretField, textField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import { ChannelsForm, type ChannelDraft, type ChannelsFormActions, type ChannelsFormState } from './channels-form.ts'
import type { ImageGenScope } from './settings-scope.ts'
import { describeModel } from '../model-catalog.ts'
import { IMAGE_MODEL_API, PRESETS_API, PROMPT_ENHANCE_API, USAGE_API, CANVAS_SKILL_API, type ComfyUiWorkflowEntry, type ComfyUiWorkflowFolder, type ComfyUiWorkflowList, type ModelMapping, type PresetProviderView } from '../protocol.ts'
import type { ImageGenKey } from './locales.ts'
import { tt, type TranslateValues } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import css from './settings-card.module.css'

/** The global (non-channel) fields this card's staged form edits. */
export interface ImageGenSettings {
  enabled?: boolean
  announceToAgent?: boolean
  allowAgentImageGeneration?: boolean
  promptApiUrl?: string
  promptApiKey?: string
  promptModel?: string
  localStoragePath?: string
  storageEnabled?: boolean
  storageEndpoint?: string
  storageRegion?: string
  storagePrefix?: string
  storageAccessKey?: string
  storageSecretKey?: string
  storageSyncGallery?: boolean
  storageSyncHistory?: boolean
  skillsEnabled?: boolean
  allowHeavySkills?: boolean
  skillAllowlist?: string
  skillOutputDir?: string
  skillHeavyTimeoutMinutes?: number
  skillAgentPreset?: string
}

/** What the card renders. */
export interface ImageGenSettingsCardState extends CardShell {
  /** Channel list staging (channels + per-channel key edits + default). */
  channels: ChannelsFormState
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  allowAgentImageGeneration: CardFieldState
  promptApiUrl: CardFieldState
  promptApiKey: CardFieldState
  promptModel: CardFieldState
  localStoragePath: CardFieldState
  storageEnabled: CardFieldState
  storageEndpoint: CardFieldState
  storageRegion: CardFieldState
  storagePrefix: CardFieldState
  storageAccessKey: CardFieldState
  storageSecretKey: CardFieldState
  storageSyncGallery: CardFieldState
  storageSyncHistory: CardFieldState
  skillsEnabled: CardFieldState
  allowHeavySkills: CardFieldState
  skillAllowlist: CardFieldState
  skillOutputDir: CardFieldState
  skillHeavyTimeoutMinutes: CardFieldState
  skillAgentPreset: CardFieldState
}

/** Result of probing the configured object storage from the card. */
export interface StorageTestOutcome {
  ok: boolean
  ms?: number
  message?: string
}

/** The registration-side face the card's slot entry injects. */
export interface ImageGenSettingsCardFace extends CardActions {
  /** Channel staging actions (committed together with the card's save). */
  channels: ChannelsFormActions
  /** Save staged edits, then upload a probe object to the configured store. */
  storageTest: () => Promise<StorageTestOutcome>
  hooks: {
    /** Card snapshot bound by the renderer as useImageGenSettingsCard. */
    imageGenSettingsCard: SnapshotStore<ImageGenSettingsCardState>
  }
}

/** Bridges the imagegen scope onto the card's staged forms. */
export class ImageGenSettingsCardController {
  private readonly form: CardForm<ImageGenSettings>
  private readonly channelsForm: ChannelsForm

  /** @param scope - the bound bridge scope for the dsh-imagegen namespace. */
  constructor(private readonly scope: ImageGenScope) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      booleanField('allowAgentImageGeneration'),
      textField('promptApiUrl'),
      secretField('promptApiKey'),
      textField('promptModel'),
      textField('localStoragePath'),
      booleanField('storageEnabled'),
      textField('storageEndpoint'),
      textField('storageRegion'),
      textField('storagePrefix'),
      textField('storageAccessKey'),
      secretField('storageSecretKey'),
      booleanField('storageSyncGallery'),
      booleanField('storageSyncHistory'),
      booleanField('skillsEnabled'),
      booleanField('allowHeavySkills'),
      textField('skillAllowlist'),
      textField('skillOutputDir'),
      textField('skillHeavyTimeoutMinutes'),
      textField('skillAgentPreset'),
    ], {
      secretSettled: (field) => this.scope.getSecretSetSnapshot(field),
    })
    this.channelsForm = new ChannelsForm(scope)
  }

  private projection(): ImageGenSettingsCardState {
    const shell = this.form.shell()
    return {
      ...shell,
      dirty: shell.dirty || this.channelsForm.snapshot().dirty,
      channels: this.channelsForm.snapshot(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      allowAgentImageGeneration: this.form.field('allowAgentImageGeneration'),
      promptApiUrl: this.form.field('promptApiUrl'),
      promptApiKey: this.form.field('promptApiKey'),
      promptModel: this.form.field('promptModel'),
      localStoragePath: this.form.field('localStoragePath'),
      storageEnabled: this.form.field('storageEnabled'),
      storageEndpoint: this.form.field('storageEndpoint'),
      storageRegion: this.form.field('storageRegion'),
      storagePrefix: this.form.field('storagePrefix'),
      storageAccessKey: this.form.field('storageAccessKey'),
      storageSecretKey: this.form.field('storageSecretKey'),
      storageSyncGallery: this.form.field('storageSyncGallery'),
      storageSyncHistory: this.form.field('storageSyncHistory'),
      skillsEnabled: this.form.field('skillsEnabled'),
      allowHeavySkills: this.form.field('allowHeavySkills'),
      skillAllowlist: this.form.field('skillAllowlist'),
      skillOutputDir: this.form.field('skillOutputDir'),
      skillHeavyTimeoutMinutes: this.form.field('skillHeavyTimeoutMinutes'),
      skillAgentPreset: this.form.field('skillAgentPreset'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and the form/channel actions.
   */
  inject(): ImageGenSettingsCardFace {
    const cardStore = this.form.bind(() => this.projection())
    this.channelsForm.subscribe(() => { cardStore.set(this.projection()) })
    return {
      hooks: {
        imageGenSettingsCard: cardStore,
      },
      channels: this.channelsForm.actions(),
      // The probe needs the values the user is looking at, so staged edits are
      // committed first; the host route then resolves the saved config itself.
      storageTest: async (): Promise<StorageTestOutcome> => {
        await this.form.save()
        try {
          const response = await fetch('/api/dsh-imagegen/storage/test', { method: 'POST' })
          const body = await response.json() as { ok?: unknown; ms?: unknown; message?: unknown }
          if (body.ok === true) return { ok: true, ms: typeof body.ms === 'number' ? body.ms : undefined }
          return { ok: false, message: typeof body.message === 'string' ? body.message : `HTTP ${response.status}` }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      ...this.form.actions(),
    }
  }
}

/** Props the renderer binds for this card. */
export type ImageGenSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/** Host-computed usage counters (generation-count badges). */
interface UsageCounters {
  byChannel: Record<string, Record<string, number>>
  totals: Record<string, number>
}

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the card, or nothing while the namespace is still loading.
 */
export function ImageGenSettingsCard(props: ImageGenSettingsCardProps) {
  // The card renders through the plugin's own dictionary so the uiLanguage
  // override applies here too — the host-locale props.t would only follow the
  // DSH interface language.
  const t = tt
  useImageGenLanguageTick()
  const state = props.useImageGenSettingsCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  // Global-section local states (prompt enhancement etc.).
  const [promptModels, setPromptModels] = useState<string[]>([])
  const [loadingPromptModels, setLoadingPromptModels] = useState(false)
  const [promptModelsError, setPromptModelsError] = useState<string | null>(null)
  const [manualPromptModelOpen, setManualPromptModelOpen] = useState(false)
  const [manualPromptModel, setManualPromptModel] = useState('')
  const [enhancementOpen, setEnhancementOpen] = useState(false)
  const [promptApiOpen, setPromptApiOpen] = useState(false)
  const [storageOpen, setStorageOpen] = useState(false)
  const [storageTesting, setStorageTesting] = useState(false)
  const [storageTestResult, setStorageTestResult] = useState<string | null>(null)
  const [skillProbing, setSkillProbing] = useState(false)
  const [skillProbeResult, setSkillProbeResult] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  // Channel list local states.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [presetPickerOpen, setPresetPickerOpen] = useState(false)
  const [comfyUiPickerOpen, setComfyUiPickerOpen] = useState(false)
  const [presets, setPresets] = useState<PresetProviderView[]>([])
  const [presetError, setPresetError] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageCounters | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Usage counters: refreshed once per card open (and after a successful save).
  useEffect(() => {
    if (!state.exposed) return
    let alive = true
    void fetch(USAGE_API, { method: 'POST' })
      .then(async response => { const body = await response.json() as { ok?: boolean; usage?: UsageCounters }; if (alive && body.ok === true && body.usage !== undefined) setUsage(body.usage) })
      .catch(() => { /* counters are best-effort */ })
    return () => { alive = false }
  }, [state.exposed])

  if (!state.available) return null
  const title = t('settings.title')
  const blocked = !state.dirty || state.invalid || state.saving || state.channels.saving
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }

  if (!state.exposed) {
    return (
      <li className={css.card}>
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.headText}>
            <span className={css.name}>{title}</span>
            <span className={css.description}>{t('settings.description')}</span>
          </span>
          <span className={open ? css.chevronOpen : css.chevron}>▾</span>
        </button>
        {open
          ? (
            <div className={css.body}>
              <p className={css.notExposed} role="status">{t('settings.notExposed')}</p>
            </div>
          )
          : null}
      </li>
    )
  }

  const channels = state.channels.channels
  const editing = editingId === null ? undefined : channels.find(channel => channel.id === editingId)

  return (
    <li className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <span className={open ? css.chevronOpen : css.chevron}>▾</span>
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}

            <section className={css.channelSection} aria-label={t('channels.title')}>
              <div className={css.sectionHeader}>
                <div>
                  <h3 className={css.sectionTitle}>{t('channels.title')}</h3>
                  <p className={css.sectionHint}>{t('channels.hint')}</p>
                </div>
              </div>
              {channels.length === 0
                ? <p className={css.channelEmpty}>{t('channels.empty')}</p>
                : (
                  <ul className={css.channelList}>
                    {channels.map(channel => {
                      const keyHeld = state.channels.keySet[channel.id] === true
                      const keyOptional = isComfyUiPreset(channel.preset)
                      // ComfyUI channels treat the API key as optional, so
                      // "no key stored" does not make the channel incomplete.
                      // A ComfyUI channel is ready when it has at least one model.
                      const ready = keyOptional ? channel.models.length > 0 : (keyHeld && channel.models.length > 0)
                      const isDefault = channel.id === state.channels.defaultChannelId
                      if (confirmDeleteId === channel.id) {
                        return (
                          <li key={channel.id} className={css.channelRow} data-action>
                            <span className={css.deleteConfirmText}>{t('channels.deleteConfirmTitle', { name: channel.name || t('channels.untitled') })}</span>
                            <button type="button" className={css.channelDanger} disabled={disabled} onClick={() => { props.channels.setChannels(channels.filter(candidate => candidate.id !== channel.id)); if (isDefault && channels.length > 1) { const next = channels.find(candidate => candidate.id !== channel.id); if (next !== undefined) props.channels.setDefaultChannel(next.id) } setConfirmDeleteId(null); if (editingId === channel.id) setEditingId(null) }}>{t('channels.confirm')}</button>
                            <button type="button" className={css.channelAction} disabled={disabled} onClick={() => { setConfirmDeleteId(null) }}>{t('channels.cancel')}</button>
                          </li>
                        )
                      }
                      return (
                        <li key={channel.id} className={css.channelRow}>
                          <span className={ready ? css.channelDotReady : css.channelDotWarn} aria-hidden="true" title={t(ready ? 'channels.statusReady' : 'channels.statusIncomplete')} />
                          <button type="button" className={css.channelMain} disabled={disabled} onClick={() => { setEditingId(channel.id) }}>
                            <span className={css.channelName}>{isDefault ? `★ ${channel.name || t('channels.untitled')}` : (channel.name || t('channels.untitled'))}</span>
                            <span className={css.channelMeta}>
                              <span className={css.channelBadge} data-warn={(!keyOptional && !keyHeld) || channel.models.length === 0 ? '' : undefined}>
                                {keyOptional
                                  ? t('channels.comfyuiKeyOptional')
                                  : (keyHeld ? t('channels.keySet') : t('channels.keyMissing'))}
                                {' · '}
                                {channel.models.length > 0 ? t('channels.modelCount', { n: channel.models.length }) : t('channels.noModels')}
                              </span>
                            </span>
                          </button>
                          <button type="button" className={css.channelAction} onClick={() => { setEditingId(channel.id) }}>{t('channels.edit')}</button>
                          <button type="button" className={css.channelAction} data-danger onClick={() => { setConfirmDeleteId(channel.id) }}>{t('channels.delete')}</button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              <div className={css.channelControls}>
              {open && presetPickerOpen ? (
                <PresetPicker
                  t={t}
                  presets={presets.filter(preset => !isComfyUiPreset(preset.id))}
                  error={presetError}
                  disabled={state.writable === false}
                  onLoad={() => {
                    setPresetError(null)
                    void fetch(PRESETS_API, { method: 'POST' })
                      .then(async response => {
                        const body = await response.json() as { ok?: boolean; presets?: PresetProviderView[]; message?: string }
                        if (!response.ok || body.ok !== true || body.presets === undefined) throw new Error(body.message ?? `HTTP ${response.status}`)
                        setPresets(body.presets)
                      })
                      .catch(error => { setPresetError(error instanceof Error ? error.message : String(error)) })
                  }}
                  onPick={(preset) => {
                    const draft = newChannelDraft(preset)
                    props.channels.setChannels([...channels, draft])
                    setPresetPickerOpen(false)
                    setEditingId(draft.id)
                  }}
                  onCustom={() => {
                    const draft = newChannelDraft(undefined)
                    props.channels.setChannels([...channels, draft])
                    setPresetPickerOpen(false)
                    setEditingId(draft.id)
                  }}
                  onClose={() => { setPresetPickerOpen(false) }}
                />
              ) : null}
              {open && comfyUiPickerOpen ? (
                <ComfyUiPicker
                  t={t}
                  presets={presets.filter(preset => isComfyUiPreset(preset.id))}
                  error={presetError}
                  disabled={state.writable === false}
                  onLoad={() => {
                    setPresetError(null)
                    // Reuse the cached presets list if it already loaded, so
                    // opening the ComfyUI picker twice in a row never double-fetches.
                    if (presets.length === 0) {
                      void fetch(PRESETS_API, { method: 'POST' })
                        .then(async response => {
                          const body = await response.json() as { ok?: boolean; presets?: PresetProviderView[]; message?: string }
                          if (!response.ok || body.ok !== true || body.presets === undefined) throw new Error(body.message ?? `HTTP ${response.status}`)
                          setPresets(body.presets)
                        })
                        .catch(error => { setPresetError(error instanceof Error ? error.message : String(error)) })
                    }
                  }}
                  onPick={(preset) => {
                    const draft = newChannelDraft(preset)
                    props.channels.setChannels([...channels, draft])
                    setComfyUiPickerOpen(false)
                    setEditingId(draft.id)
                  }}
                  onClose={() => { setComfyUiPickerOpen(false) }}
                />
              ) : null}

              <div className={css.channelAddRow}>
                <button type="button" className={css.channelAdd} disabled={disabled} onClick={() => { setPresetError(null); setPresetPickerOpen(true) }}>+ {t('channels.addProvider')}</button>
                <button type="button" className={css.channelAdd} disabled={disabled} onClick={() => { setPresetError(null); setComfyUiPickerOpen(true) }}>+ {t('channels.addComfyui')}</button>
                <button type="button" className={css.channelAdd} disabled={disabled} onClick={() => { addCustomChannel(channels, props.channels, setEditingId) }}>+ {t('channels.addCustom')}</button>
              </div>
              </div>
            </section>

            <button
              type="button"
              className={css.disclosure}
              aria-expanded={enhancementOpen}
              onClick={() => { setEnhancementOpen(open => !open) }}
            >
              <span>{t('settings.promptEnhanceTitle')}</span>
              <span>{t('settings.optional')}</span>
              <span aria-hidden="true">{enhancementOpen ? '⌃' : '⌄'}</span>
            </button>
            {enhancementOpen ? <section className={css.optionalContent} aria-label={t('settings.promptEnhanceTitle')}>
            <p className={css.sectionHint}>{t('settings.promptEnhanceHint')}</p>
            <div className={css.sectionHeader}>
              <div>
                <h3 className={css.sectionTitle}>{t('settings.promptModel')}</h3>
                <p className={css.sectionHint}>{t('settings.promptModelDetectionHint')}</p>
              </div>
              <button
                type="button"
                className={css.modelFetch}
                disabled={disabled || loadingPromptModels}
                onClick={() => {
                  setLoadingPromptModels(true)
                  setPromptModelsError(null)
                  void fetch(PROMPT_ENHANCE_API.models, { method: 'POST' })
                    .then(async response => {
                      const body = await response.json() as { ok?: boolean; models?: string[]; message?: string }
                      if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
                      setPromptModels(body.models ?? [])
                    })
                    .catch(error => { setPromptModelsError(error instanceof Error ? error.message : String(error)) })
                    .finally(() => { setLoadingPromptModels(false) })
                }}
              >
                {loadingPromptModels ? t('settings.promptModelsLoading') : t('settings.promptModelsFetch')}
              </button>
            </div>
            <div className={css.modelSummary}>
              {state.promptModel.text.trim() !== '' ? (
                <span className={css.modelChip}>
                  <span>{state.promptModel.text}</span>
                  <button type="button" disabled={disabled} aria-label={`${t('settings.removeModel')}: ${state.promptModel.text}`} onClick={() => { props.edit('promptModel', '') }}>×</button>
                </span>
              ) : null}
              <button type="button" className={css.addModel} disabled={disabled} onClick={() => { setManualPromptModelOpen(open => !open); setEnhancementOpen(true) }}>
                {manualPromptModelOpen ? t('settings.cancelAddModel') : t('settings.addModel')}
              </button>
            </div>
            {manualPromptModelOpen ? (
              <div className={css.manualModelRow}>
                <input className={css.input} value={manualPromptModel} placeholder={t('settings.addPromptModelPlaceholder')} disabled={disabled} onChange={event => { setManualPromptModel(event.target.value) }} />
                <button type="button" className={css.addModel} disabled={disabled || manualPromptModel.trim() === ''} onClick={() => { props.edit('promptModel', manualPromptModel); setManualPromptModel('') }}>{t('settings.addModelConfirm')}</button>
              </div>
            ) : null}
            {promptModels.length > 0 ? (
              <div className={css.modelCandidateList} role="radiogroup" aria-label={t('settings.promptModelsCandidates')}>
                <span className={css.modelCandidateLabel}>{t('settings.promptModelsCandidates')}</span>
                {promptModels.map(candidate => (
                  <button
                    key={candidate}
                    type="button"
                    role="radio"
                    className={css.modelCandidate}
                    aria-checked={state.promptModel.text === candidate}
                    data-selected={state.promptModel.text === candidate ? '' : undefined}
                    disabled={disabled}
                    onClick={() => { props.edit('promptModel', candidate) }}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            ) : null}
            {promptModelsError !== null ? <p className={css.failed} role="status">{promptModelsError}</p> : null}
            <button type="button" className={css.inlineDisclosure} aria-expanded={promptApiOpen} onClick={() => { setPromptApiOpen(open => !open) }}>
              <span>{t('settings.promptApiAdvanced')}</span>
              <span aria-hidden="true">{promptApiOpen ? '⌃' : '⌄'}</span>
            </button>
            {promptApiOpen ? <div className={css.optionalContent}>
            <ValueField
              id="dsh-imagegen-settings-prompt-apiurl"
              label={t('settings.promptApiUrl')}
              hint={t('settings.promptApiUrlHint')}
              placeholder="https://api.openai.com/v1"
              {...fieldProps}
              {...state.promptApiUrl}
              onEdit={(text) => { props.edit('promptApiUrl', text) }}
              onReset={() => { props.resetField('promptApiUrl') }}
            />
            <ValueField
              id="dsh-imagegen-settings-prompt-apikey"
              label={t('settings.promptApiKey')}
              hint={t('settings.promptApiKeyHint')}
              placeholder="sk-…"
              secret
              {...fieldProps}
              {...state.promptApiKey}
              overridden={false}
              onEdit={(text) => { props.edit('promptApiKey', text) }}
              onReset={() => { props.resetField('promptApiKey') }}
            />
            </div> : null}
            </section> : null}

            <button type="button" className={css.disclosure} aria-expanded={storageOpen} onClick={() => { setStorageOpen(open => !open) }}>
              <span>{t('settings.storageTitle')}</span>
              <span aria-hidden="true">{storageOpen ? '⌃' : '⌄'}</span>
            </button>
            {storageOpen ? <div className={css.optionalContent}>
            <ValueField
              id="dsh-imagegen-settings-local-storage-path"
              label={t('settings.localStoragePath')}
              hint={t('settings.localStoragePathHint')}
              placeholder="E:\\dsh-imagegen-data"
              {...fieldProps}
              {...state.localStoragePath}
              onEdit={(text) => { props.edit('localStoragePath', text) }}
              onReset={() => { props.resetField('localStoragePath') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-storage-enabled"
              label={t('settings.storageEnabled')}
              hint={t('settings.storageHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.storageEnabled}
              onEdit={(text) => { props.edit('storageEnabled', text) }}
              onReset={() => { props.resetField('storageEnabled') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-endpoint"
              label={t('settings.storageEndpoint')}
              hint={t('settings.storageEndpointHint')}
              placeholder="https://bucket-appid.cos.ap-guangzhou.myqcloud.com"
              {...fieldProps}
              {...state.storageEndpoint}
              onEdit={(text) => { props.edit('storageEndpoint', text) }}
              onReset={() => { props.resetField('storageEndpoint') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-region"
              label={t('settings.storageRegion')}
              hint={t('settings.storageRegionHint')}
              placeholder="ap-guangzhou"
              {...fieldProps}
              {...state.storageRegion}
              onEdit={(text) => { props.edit('storageRegion', text) }}
              onReset={() => { props.resetField('storageRegion') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-prefix"
              label={t('settings.storagePrefix')}
              hint={t('settings.storagePrefixHint')}
              placeholder="dsh-imagegen"
              {...fieldProps}
              {...state.storagePrefix}
              onEdit={(text) => { props.edit('storagePrefix', text) }}
              onReset={() => { props.resetField('storagePrefix') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-accesskey"
              label={t('settings.storageAccessKey')}
              hint={t('settings.storageAccessKeyHint')}
              placeholder="AKID…"
              {...fieldProps}
              {...state.storageAccessKey}
              onEdit={(text) => { props.edit('storageAccessKey', text) }}
              onReset={() => { props.resetField('storageAccessKey') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-secretkey"
              label={t('settings.storageSecretKey')}
              hint={t('settings.storageSecretKeyHint')}
              placeholder="…"
              secret
              {...fieldProps}
              {...state.storageSecretKey}
              overridden={false}
              onEdit={(text) => { props.edit('storageSecretKey', text) }}
              onReset={() => { props.resetField('storageSecretKey') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-storage-gallery"
              label={t('settings.storageSyncGallery')}
              hint={t('settings.storageSyncGalleryHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.storageSyncGallery}
              onEdit={(text) => { props.edit('storageSyncGallery', text) }}
              onReset={() => { props.resetField('storageSyncGallery') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-storage-history"
              label={t('settings.storageSyncHistory')}
              hint={t('settings.storageSyncHistoryHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.storageSyncHistory}
              onEdit={(text) => { props.edit('storageSyncHistory', text) }}
              onReset={() => { props.resetField('storageSyncHistory') }}
            />
            <div className={css.modelSummary}>
              <button
                type="button"
                className={css.addModel}
                disabled={disabled || storageTesting}
                onClick={() => {
                  setStorageTesting(true)
                  setStorageTestResult(null)
                  void props.storageTest().then(outcome => {
                    setStorageTestResult(outcome.ok
                      ? t('settings.storageTestOk', { ms: outcome.ms ?? 0 })
                      : t('settings.storageTestFailed', { error: outcome.message ?? 'error' }))
                  }).finally(() => { setStorageTesting(false) })
                }}
              >
                {storageTesting ? t('settings.storageTesting') : t('settings.storageTest')}
              </button>
              {storageTestResult !== null ? <p className={css.failed} role="status">{storageTestResult}</p> : null}
            </div>
            <p className={css.hint}>{t('settings.storageKeyHint')}</p>
            </div> : null}

            {/* ---------- infinite-canvas skills ---------- */}
            <BooleanField
              id="dsh-imagegen-settings-skills-enabled"
              label={t('settings.skillsEnabled')}
              hint={t('settings.skillsEnabledHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.skillsEnabled}
              onEdit={(text) => { props.edit('skillsEnabled', text) }}
              onReset={() => { props.resetField('skillsEnabled') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-skills-heavy"
              label={t('settings.allowHeavySkills')}
              hint={t('settings.allowHeavySkillsHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.allowHeavySkills}
              onEdit={(text) => { props.edit('allowHeavySkills', text) }}
              onReset={() => { props.resetField('allowHeavySkills') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-allowlist"
              label={t('settings.skillAllowlist')}
              hint={t('settings.skillAllowlistHint')}
              placeholder="extract-content, image-to-editable-ppt"
              {...fieldProps}
              {...state.skillAllowlist}
              onEdit={(text) => { props.edit('skillAllowlist', text) }}
              onReset={() => { props.resetField('skillAllowlist') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-output"
              label={t('settings.skillOutputDir')}
              hint={t('settings.skillOutputDirHint')}
              placeholder=""
              {...fieldProps}
              {...state.skillOutputDir}
              onEdit={(text) => { props.edit('skillOutputDir', text) }}
              onReset={() => { props.resetField('skillOutputDir') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-timeout"
              label={t('settings.skillHeavyTimeout')}
              hint={t('settings.skillHeavyTimeoutHint')}
              placeholder="20"
              {...fieldProps}
              {...state.skillHeavyTimeoutMinutes}
              onEdit={(text) => { props.edit('skillHeavyTimeoutMinutes', text) }}
              onReset={() => { props.resetField('skillHeavyTimeoutMinutes') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-preset"
              label={t('settings.skillAgentPreset')}
              hint={t('settings.skillAgentPresetHint')}
              placeholder=""
              {...fieldProps}
              {...state.skillAgentPreset}
              onEdit={(text) => { props.edit('skillAgentPreset', text) }}
              onReset={() => { props.resetField('skillAgentPreset') }}
            />
            <div className={css.modelSummary}>
              <button
                type="button"
                className={css.addModel}
                disabled={disabled || skillProbing}
                onClick={() => {
                  setSkillProbing(true)
                  setSkillProbeResult(null)
                  void fetch(CANVAS_SKILL_API.list, { method: 'POST' })
                    .then(async response => await response.json() as { ok?: boolean; skills?: unknown[]; agentAvailable?: boolean; registryAvailable?: boolean })
                    .then(body => {
                      const total = Array.isArray(body.skills) ? body.skills.length : 0
                      setSkillProbeResult(t('settings.skillProbeOk', {
                        count: total,
                        agent: body.agentAvailable === true ? t('settings.skillProbeAgentOn') : t('settings.skillProbeAgentOff'),
                      }))
                    })
                    .catch(caught => { setSkillProbeResult(t('settings.storageTestFailed', { error: caught instanceof Error ? caught.message : String(caught) })) })
                    .finally(() => { setSkillProbing(false) })
                }}
              >
                {skillProbing ? t('settings.skillProbing') : t('settings.skillProbe')}
              </button>
              {skillProbeResult !== null ? <p className={css.hint} role="status">{skillProbeResult}</p> : null}
            </div>
            <p className={css.hint}>{t('settings.skillsHint')}</p>

            <button type="button" className={css.disclosure} aria-expanded={moreOpen} onClick={() => { setMoreOpen(open => !open) }}>
              <span>{t('settings.moreOptions')}</span>
              <span aria-hidden="true">{moreOpen ? '⌃' : '⌄'}</span>
            </button>
            {moreOpen ? <div className={css.optionalContent}>
            <BooleanField
              id="dsh-imagegen-settings-enabled"
              label={t('settings.enabled')}
              hint={t('settings.enabledHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.enabled}
              onEdit={(text) => { props.edit('enabled', text) }}
              onReset={() => { props.resetField('enabled') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-announce"
              label={t('settings.announceToAgent')}
              hint={t('settings.announceToAgentHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.announceToAgent}
              onEdit={(text) => { props.edit('announceToAgent', text) }}
              onReset={() => { props.resetField('announceToAgent') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-agent-generation"
              label={t('settings.allowAgentImageGeneration')}
              hint={t('settings.allowAgentImageGenerationHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.allowAgentImageGeneration}
              onEdit={(text) => { props.edit('enabled', text) }}
              onReset={() => { props.resetField('enabled') }}
            />
            </div> : null}
            <div className={css.footer}>
              {(state.failed || state.channels.failed) ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving || state.channels.saving}
                onClick={() => { props.discard(); props.channels.discard() }}
              >
                {t('settings.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={blocked}
                onClick={() => { void props.channels.commit(); void props.save() }}
              >
                {t(!state.saving && !state.channels.saving ? 'settings.save' : 'settings.saving')}
              </button>
            </div>
          </div>
        )
        : null}

      {open && editing !== undefined ? (
        <ChannelEditor
          key={editing.id}
          t={t}
          channel={editing}
          keyHeld={state.channels.keySet[editing.id] === true}
          usage={usage}
          otherChannels={channels.filter(channel => channel.id !== editing.id)}
          isDefault={editing.id === state.channels.defaultChannelId}
          writable={state.writable}
          onPatch={(patch) => { replaceChannel(channels, editing.id, patch, props.channels) }}
          onSetModels={(models) => { props.channels.setChannels(channels.map(channel => channel.id === editing.id ? { ...channel, models } : channel)) }}
          onSetKey={(value) => { props.channels.setChannelKey(editing.id, value) }}
          onSetDefault={() => { props.channels.setDefaultChannel(editing.id) }}
          onRemove={() => { props.channels.setChannels(channels.filter(channel => channel.id !== editing.id)); if (editing.id === state.channels.defaultChannelId && channels.length > 1) { const next = channels.find(channel => channel.id !== editing.id); if (next !== undefined) props.channels.setDefaultChannel(next.id) } setEditingId(null) }}
          onClose={() => { setEditingId(null) }}
        />
      ) : null}

    </li>
  )
}

/** Channel row + dialog helpers -------------------------------------------------- */

function newChannelDraft(preset: PresetProviderView | undefined): ChannelDraft {
  return {
    id: clientId(),
    preset: preset?.id ?? '',
    name: preset?.name ?? '',
    apiUrl: preset?.apiUrl ?? '',
    models: (preset?.models ?? []).map(model => ({ ...model })),
  }
}

/** Whether the channel was created from a ComfyUI preset (preset id starts with `comfyui-`).
 *  ComfyUI channels treat the API key as optional: most local installations have no auth,
 *  and remote ones using a reverse proxy may carry a Bearer token. The editor surfaces this
 *  as a softer "key is optional" hint rather than the usual "key is required" copy. */
function isComfyUiPreset(presetId: string): boolean {
  return /^comfyui-/i.test(presetId.trim())
}

/** Result of the image-models detection call, branched by the channel preset.
 *  - `openai`:  flat list of upstream model ids (default).
 *  - `comfyui`: folder-grouped workflow listing (ComfyUI preset only).
 */
type ModelCandidates =
  | { kind: 'openai'; models: string[] }
  | { kind: 'comfyui'; folders: ComfyUiWorkflowFolder[]; total: number }

function addCustomChannel(channels: ChannelDraft[], form: ChannelsFormActions, openEditor: (id: string) => void): void {
  const draft = newChannelDraft(undefined)
  form.setChannels([...channels, draft])
  openEditor(draft.id)
}

/** Patch one field (or models) of one staged channel. */
function replaceChannel(channels: ChannelDraft[], id: string, patch: Partial<ChannelDraft>, form: ChannelsFormActions): void {
  form.setChannels(channels.map(channel => channel.id === id ? { ...channel, ...patch } : channel))
}

function clientId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : undefined
  return random ?? `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Built-in provider picker, expanded inside the settings card. */
function PresetPicker(props: {
  t: (key: ImageGenKey, params?: Record<string, string | number>) => string
  presets: PresetProviderView[]
  error: string | null
  disabled: boolean
  onLoad: () => void
  onPick: (preset: PresetProviderView) => void
  onCustom: () => void
  onClose: () => void
}) {
  const { t } = props
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    props.onLoad()
  }, [])
  return (
    <section className={css.presetInline} aria-label={t('channels.presetPickerTitle')}>
      <header className={css.presetInlineHeader}>
        <div>
          <h3 className={css.sectionTitle}>{t('channels.presetPickerTitle')}</h3>
          <p className={css.sectionHint}>{t('channels.presetPickerHint')}</p>
        </div>
        <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
      </header>
      <div className={css.presetList}>
        {props.presets.map(preset => (
          <button key={preset.id} type="button" className={css.presetRow} disabled={props.disabled} onClick={() => { props.onPick(preset) }}>
            <span className={css.presetName}>{preset.name}</span>
            <span className={css.presetMeta}>{preset.models.map(model => model.alias).join(' · ')}</span>
          </button>
        ))}
        <button type="button" className={css.presetRow} data-custom disabled={props.disabled} onClick={props.onCustom}>
          <span className={css.presetName}>+ {t('channels.addCustom')}</span>
          <span className={css.presetHint}>{t('channels.presetCustomHint')}</span>
        </button>
        {props.error !== null ? <p className={css.failed} role="status">{t('channels.presetLoadFailed', { error: props.error })}</p> : null}
      </div>
    </section>
  )
}

/** ComfyUI sub-picker: only the `comfyui-*` presets are shown. Hosted as a
 *  separate "添加 ComfyUI 服务" button next to the generic add-provider so the
 *  ComfyUI option is discoverable without having to scroll past the regular
 *  cloud providers. Includes a quick connectivity probe so the user can
 *  verify the address is reachable *before* committing to a preset. */
function ComfyUiPicker(props: {
  t: (key: ImageGenKey, params?: Record<string, string | number>) => string
  presets: PresetProviderView[]
  error: string | null
  disabled: boolean
  onLoad: () => void
  onPick: (preset: PresetProviderView) => void
  onClose: () => void
}) {
  const { t } = props
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    props.onLoad()
  }, [])

  // The default URL pre-fills from the first preset (typically the local one
  // pointing at 127.0.0.1:8188). The probe reuses the same `/image-models`
  // route the channel editor calls, so the result is exactly what the user
  // would see after creating the channel and clicking "Detect".
  const initialUrl = props.presets[0]?.apiUrl ?? 'http://127.0.0.1:8188'
  const [probeUrl, setProbeUrl] = useState(initialUrl)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Keep the URL in sync when the preset list finishes loading (the first
  // render usually has an empty list until the fetch resolves).
  useEffect(() => {
    if (probeUrl.trim() === '' && props.presets[0]?.apiUrl !== undefined) {
      setProbeUrl(props.presets[0].apiUrl)
    }
  }, [props.presets])

  const probe = (): void => {
    const url = probeUrl.trim()
    if (url === '') return
    setProbing(true)
    setProbeResult(null)
    void fetch(IMAGE_MODEL_API.models, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `probeOnly: true` makes the route return a connectivity probe
      // (POST /prompt) instead of the full workflow listing — appropriate
      // for the picker, which runs before any channel is saved.
      body: JSON.stringify({ apiUrl: url, forceKind: 'comfyui', probeOnly: true }),
    })
      .then(async response => {
        const body = await response.json() as {
          ok?: boolean
          kind?: 'openai' | 'comfyui'
          probe?: { reachable: boolean; message: string; httpStatus?: number }
          message?: string
          code?: string
        }
        if (!response.ok || body.ok !== true) {
          setProbeResult({ ok: false, message: body.message ?? `HTTP ${response.status}` })
          return
        }
        if (body.kind === 'comfyui' && body.probe !== undefined) {
          setProbeResult({ ok: body.probe.reachable, message: body.probe.message })
          return
        }
        // Should not happen — picker always force-casts to ComfyUI.
        setProbeResult({ ok: false, message: t('channels.comfyuiProbeNotComfyui') })
      })
      .catch(error => {
        setProbeResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => { setProbing(false) })
  }

  return (
    <section className={css.presetInline} aria-label={t('channels.comfyuiPickerTitle')}>
      <header className={css.presetInlineHeader}>
        <div>
          <h3 className={css.sectionTitle}>{t('channels.comfyuiPickerTitle')}</h3>
          <p className={css.sectionHint}>{t('channels.comfyuiPickerHint')}</p>
        </div>
        <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
      </header>

      {/* Connectivity probe — verify the URL is reachable *before* picking a
          preset, so the user does not commit to a broken address. */}
      <div className={css.manualModelRow}>
        <input
          className={css.input}
          value={probeUrl}
          placeholder="http://127.0.0.1:8188"
          disabled={probing}
          onChange={event => { setProbeUrl(event.target.value); setProbeResult(null) }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); probe() } }}
        />
        <button
          type="button"
          className={css.modelFetch}
          disabled={probing || probeUrl.trim() === ''}
          onClick={probe}
        >
          {probing ? t('channels.detecting') : t('channels.comfyuiProbe')}
        </button>
      </div>
      {probeResult !== null
        ? (
          <p
            className={probeResult.ok ? css.detectOk : css.failed}
            role="status"
          >
            {probeResult.ok
              ? `✓ ${probeResult.message}`
              : `× ${probeResult.message}`}
          </p>
        )
        : null}

      <div className={css.presetList}>
        {props.presets.length === 0
          ? <p className={css.sectionHint}>{t('channels.comfyuiPickerEmpty')}</p>
          : props.presets.map(preset => (
              <button key={preset.id} type="button" className={css.presetRow} disabled={props.disabled} onClick={() => { props.onPick(preset) }}>
                <span className={css.presetName}>{preset.name}</span>
                <span className={css.presetMeta}>{preset.models.map(model => model.alias).join(' · ')}</span>
              </button>
            ))}
        {props.error !== null ? <p className={css.failed} role="status">{t('channels.presetLoadFailed', { error: props.error })}</p> : null}
      </div>
    </section>
  )
}

/** Channel editor (modal): key, display name, API URL, model catalog. */
function ChannelEditor(props: {
  t: (key: ImageGenKey, params?: Record<string, string | number>) => string
  channel: ChannelDraft
  keyHeld: boolean
  usage: UsageCounters | null
  otherChannels: ChannelDraft[]
  isDefault: boolean
  writable: boolean
  onPatch: (patch: Partial<ChannelDraft>) => void
  onSetModels: (models: ModelMapping[]) => void
  onSetKey: (value: string | undefined) => void
  onSetDefault: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { t, channel } = props
  const [keyDraft, setKeyDraft] = useState('')
  const [candidates, setCandidates] = useState<ModelCandidates | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [manualId, setManualId] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [copyFrom, setCopyFrom] = useState('')
  // ComfyUI candidate folders are collapsed by default; only the root folder
  // is expanded to keep the dialog scannable. Users can click to expand.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())

  const generatedCount = (alias: string): number => {
    if (props.usage === null) return 0
    const channelBucket = props.usage.byChannel[channel.id] ?? props.usage.byChannel[`name:${channel.name}`] ?? {}
    return channelBucket[alias] ?? props.usage.totals[alias] ?? 0
  }

  // ComfyUI presets treat the API key as optional; detection works without one.
  const comfyUi = isComfyUiPreset(channel.preset)

  /** Add one candidate workflow to the channel's model catalog as
   *  `comfyui:<folder>/<name>`. Existing entries with the same alias are
   *  not duplicated. */
  const addComfyUiWorkflow = (entry: ComfyUiWorkflowEntry): void => {
    // Both alias and id carry the `comfyui:` prefix: the engine routes by
    // `wireModel` family detection, and a missing prefix on `id` was the
    // root cause of "task submitted but engine routed through the OpenAI
    // path" — the upstream id is what `request.upstream` ends up as.
    const id = `comfyui:${entry.path}`
    if (channel.models.some(model => model.alias === id)) return
    props.onSetModels([...channel.models, { alias: id, id }])
  }

  const toggleFolder = (folderKey: string): void => {
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(folderKey)) next.delete(folderKey)
      else next.add(folderKey)
      return next
    })
  }

  /** Group the channel's already-added models by ComfyUI folder (workflow
   *  id starts with `comfyui:` and the remainder encodes the path). Falls
   *  back to a single "已添加" bucket for non-ComfyUI presets. */
  const groupedSelected = (): Array<{ folder: string; items: Array<{ index: number; model: ModelMapping }> }> => {
    if (!comfyUi) return [{ folder: '', items: channel.models.map((m, i) => ({ index: i, model: m })) }]
    const buckets = new Map<string, Array<{ index: number; model: ModelMapping }>>()
    channel.models.forEach((model, index) => {
      const id = model.id.startsWith('comfyui:') ? model.id.slice('comfyui:'.length) : model.id
      const folder = id.includes('/') ? id.split('/')[0]! : ''
      const bucket = buckets.get(folder) ?? []
      bucket.push({ index, model })
      buckets.set(folder, bucket)
    })
    const out: Array<{ folder: string; items: Array<{ index: number; model: ModelMapping }> }> = []
    for (const [folder, items] of buckets.entries()) out.push({ folder, items })
    out.sort((a, b) => {
      if (a.folder === '' && b.folder !== '') return -1
      if (a.folder !== '' && b.folder === '') return 1
      return a.folder.localeCompare(b.folder)
    })
    return out
  }

  const detect = (): void => {
    setDetecting(true)
    setDetectError(null)
    const payload: Record<string, unknown> = { channelId: channel.id }
    if (channel.apiUrl.trim() !== '') payload.apiUrl = channel.apiUrl.trim()
    if (keyDraft.trim() !== '') payload.apiKey = keyDraft.trim()
    // Force the dispatch to ComfyUI when the channel was created from a
    // comfyui-* preset, so even old saved channels whose `preset` field
    // never landed in settings still take the right code path.
    payload.forceKind = isComfyUiPreset(channel.preset) ? 'comfyui' : 'openai'
    void fetch(IMAGE_MODEL_API.models, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(async response => {
        const body = await response.json() as {
          ok?: boolean
          kind?: 'openai' | 'comfyui'
          models?: string[]
          workflows?: ComfyUiWorkflowList
          message?: string
        }
        if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
        if (body.kind === 'comfyui' && body.workflows !== undefined) {
          setCandidates({ kind: 'comfyui', folders: body.workflows.folders, total: body.workflows.total })
          return
        }
        setCandidates({ kind: 'openai', models: body.models ?? [] })
      })
      .catch(error => { setDetectError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setDetecting(false) })
  }

  // Auto-detect once when the dialog opens with a complete endpoint.
  const autoDetected = useRef(false)
  useEffect(() => {
    if (autoDetected.current) return
    autoDetected.current = true
    if (channel.apiUrl.trim() !== '' && (comfyUi || props.keyHeld || keyDraft.trim() !== '')) detect()
  }, [])

  const addManual = (): void => {
    const id = manualId.trim()
    if (id === '') return
    const next = [...channel.models]
    const alias = id
    if (!next.some(model => model.alias === alias)) next.push({ alias, id })
    props.onSetModels(next)
    setManualId('')
  }

  const copyFromChannel = (): void => {
    const source = props.otherChannels.find(chance => chance.id === copyFrom)
    if (source === undefined) return
    const merged = [...channel.models]
    for (const model of source.models) {
      const alias = model.alias
      // Copy with a collision suffix so both sources stay selectable.
      let unique = alias
      let suffix = 2
      while (merged.some(entry => entry.alias === unique)) unique = `${alias} (${suffix++})`
      merged.push({ alias: unique, id: model.id })
    }
    props.onSetModels(merged)
    setCopyFrom('')
  }

  return (
    <div className={css.editorBackdrop} role="dialog" aria-modal="true" aria-label={`${t('channels.editorTitle')} · ${channel.name || t('channels.untitled')}`} onClick={props.onClose}>
      <div className={css.editorPanel} onClick={event => { event.stopPropagation() }}>
        <header className={css.editorHeader}>
          <div>
            <h3 className={css.sectionTitle}>{t('channels.editorTitle')} · {channel.name || t('channels.untitled')}</h3>
            <p className={css.sectionHint}>{t('channels.editorSaveNote')}</p>
          </div>
          <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
        </header>

        <div className={css.editorField}>
          <label className={css.label} htmlFor="dsh-imagegen-channel-name">{t('channels.displayName')}</label>
          <input id="dsh-imagegen-channel-name" className={css.input} value={channel.name} placeholder={t('channels.untitled')} disabled={!props.writable} onChange={event => { props.onPatch({ name: event.target.value }) }} />
        </div>
        <div className={css.editorField}>
          <label className={css.label} htmlFor="dsh-imagegen-channel-url">{t('channels.apiUrl')}</label>
          <input id="dsh-imagegen-channel-url" className={css.input} value={channel.apiUrl} placeholder="https://api.example.com/v1" disabled={!props.writable} onChange={event => { props.onPatch({ apiUrl: event.target.value }) }} />
        </div>
        {comfyUi
          ? (
            <div className={css.editorField}>
              <label className={css.label} htmlFor="dsh-imagegen-channel-install-dir">{t('channels.comfyuiInstallDir')}</label>
              <input
                id="dsh-imagegen-channel-install-dir"
                className={css.input}
                value={channel.installDir ?? ''}
                placeholder={t('channels.comfyuiInstallDirPlaceholder')}
                disabled={!props.writable}
                onChange={event => { props.onPatch({ installDir: event.target.value }) }}
              />
              <p className={css.sectionHint}>{t('channels.comfyuiInstallDirHint')}</p>
            </div>
          )
          : null}
        <div className={css.editorField}>
          <div className={css.head}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-key">{t('channels.apiKey')}</label>
            {props.keyHeld || keyDraft !== ''
              ? (
                <button type="button" className={css.reset} disabled={!props.writable} onClick={() => { setKeyDraft(''); props.onSetKey(undefined) }}>
                  {t('channels.keyClear')}
                </button>
              )
              : null}
          </div>
          <input
            id="dsh-imagegen-channel-key"
            className={css.input}
            type="password"
            autoComplete="off"
            value={keyDraft}
            placeholder={props.keyHeld ? t('channels.keyReplaceHint') : (comfyUi ? t('channels.comfyuiKeyOptionalHint') : t('channels.keyMissingHint'))}
            disabled={!props.writable}
            onChange={event => { const value = event.target.value; setKeyDraft(value); props.onSetKey(value === '' ? undefined : value) }}
          />
          {comfyUi ? <p className={css.sectionHint}>{t('channels.comfyuiKeyNote')}</p> : null}
        </div>

        <div className={css.editorDivider} />

        <div className={css.editorSectionHeader}>
          <h4 className={css.label}>{comfyUi ? t('channels.comfyuiWorkflowCatalogTitle') : t('channels.modelCatalogTitle')}</h4>
          <button
            type="button"
            className={css.modelFetch}
            disabled={!props.writable || detecting || channel.apiUrl.trim() === ''}
            onClick={detect}
          >
            {detecting ? t('channels.detecting') : t('channels.detect')}
          </button>
        </div>
        {comfyUi
          ? <p className={css.sectionHint}>{t('channels.comfyuiModelHint')}</p>
          : null}
        {detectError !== null ? <p className={css.failed} role="status">{t('channels.detectFailed', { error: detectError })}</p> : null}
        {candidates !== null && detectError === null
          ? (
            <p className={css.detectOk} role="status">
              {candidates.kind === 'comfyui'
                ? t('channels.comfyuiDetectOk', { n: candidates.total })
                : t('channels.detectSuccess', { n: candidates.models.length })}
            </p>
          )
          : null}

        {/* Candidate listing (after a successful detection). ComfyUI shows
            folder-grouped workflows; other providers show a flat id list. The
            un-grouped (root) bucket has no header — its workflows are listed
            at the top of the candidate list so users don't see a "Root" tier
            they would never intentionally create. */}
        {candidates?.kind === 'comfyui'
          ? (
            <ul className={css.modelRows} aria-label={t('channels.candidatesTitle')}>
              {candidates.folders.map(folder => {
                const renderRow = (workflow: ComfyUiWorkflowEntry): JSX.Element => {
                  const candidateId = `comfyui:${workflow.path}`
                  const alreadyAdded = channel.models.some(model => model.alias === candidateId)
                  return (
                    <li key={workflow.id} className={css.modelRow} data-candidate>
                      <span className={css.modelRowInfo}>
                        <span className={css.modelRowName}>{workflow.name}</span>
                        <span className={css.modelRowPath}>{workflow.path}</span>
                      </span>
                      <button
                        type="button"
                        className={css.addModel}
                        disabled={!props.writable || alreadyAdded}
                        onClick={() => { addComfyUiWorkflow(workflow) }}
                      >
                        {alreadyAdded ? t('channels.comfyuiAlreadyAdded') : t('channels.comfyuiAddWorkflow')}
                      </button>
                    </li>
                  )
                }
                // Root bucket: no header, workflows listed inline at the top.
                if (folder.name === '') {
                  return (
                    <li key="__root__" className={css.modelRootBucket}>
                      {folder.workflows.map(workflow => renderRow(workflow))}
                    </li>
                  )
                }
                const folderKey = folder.name
                const collapsed = collapsedFolders.has(folderKey)
                return (
                  <li key={folderKey} className={css.modelFolder}>
                    <button
                      type="button"
                      className={css.modelFolderHeader}
                      aria-expanded={!collapsed}
                      onClick={() => { toggleFolder(folderKey) }}
                    >
                      <span aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
                      <span className={css.modelFolderName}>{folder.name}</span>
                      <span className={css.modelFolderCount}>{folder.workflows.length}</span>
                    </button>
                    {!collapsed
                      ? (
                        <ul className={css.modelFolderList}>
                          {folder.workflows.map(workflow => renderRow(workflow))}
                        </ul>
                      )
                      : null}
                  </li>
                )
              })}
            </ul>
          )
          : null}

        {candidates?.kind === 'openai' && candidates.models.length > 0
          ? (
            <ul className={css.modelRows} aria-label={t('channels.candidatesTitle')}>
              {candidates.models.map(modelId => (
                <li key={modelId} className={css.modelRow} data-candidate>
                  <span className={css.modelRowInfo}>
                    <span className={css.modelRowName}>{modelId}</span>
                  </span>
                  <button
                    type="button"
                    className={css.addModel}
                    disabled={!props.writable || channel.models.some(model => model.alias === modelId)}
                    onClick={() => {
                      const id = modelId
                      if (channel.models.some(model => model.alias === id)) return
                      props.onSetModels([...channel.models, { alias: id, id }])
                    }}
                  >
                    {t('channels.addModelConfirm')}
                  </button>
                </li>
              ))}
            </ul>
          )
          : null}

        {/* Selected models (the persisted catalog). Grouped by folder for ComfyUI;
            the un-grouped (root) bucket is rendered inline with no header so users
            don't see a "Root" tier they would never intentionally create. */}
        {channel.models.length === 0
          ? <p className={css.sectionHint}>{comfyUi ? t('channels.comfyuiNoModelsHint') : t('channels.noModelsHint')}</p>
          : (
            <ul className={css.modelRows}>
              {groupedSelected().map(group => {
                const groupKey = group.folder === '' ? '__selected_root__' : group.folder
                const collapsed = collapsedFolders.has(groupKey)
                const renderItem = ({ index, model }: { index: number; model: ModelMapping }): JSX.Element => {
                  const entry = describeModel(model.id || model.alias)
                  const generated = generatedCount(model.alias)
                  return (
                    <li key={`${model.alias}-${index}`} className={css.modelRow}>
                      <div className={css.modelRowInputs}>
                        <input className={css.input} value={model.alias} aria-label={t('channels.modelAliasLabel')} disabled={!props.writable} onChange={event => {
                          const next = [...channel.models]
                          next[index] = { ...model, alias: event.target.value }
                          props.onSetModels(next)
                        }} />
                        <span className={css.modelArrow}>→</span>
                        <input className={css.input} value={model.id} aria-label={t('channels.modelIdLabel')} disabled={!props.writable} onChange={event => {
                          const next = [...channel.models]
                          next[index] = { ...model, id: event.target.value }
                          props.onSetModels(next)
                        }} />
                      </div>
                      <div className={css.modelRowBadges}>
                        <span className={css.modelBadge}>{entry.labelZh}{entry.known ? '' : ` · ${t('channels.unknownProtocol')}`}</span>
                        {generated > 0 ? <span className={css.modelBadge} data-verified>{t('channels.generated', { n: generated })}</span> : null}
                        <button type="button" className={css.modelRowRemove} disabled={!props.writable} aria-label={`${t('channels.removeModel')}: ${model.alias}`} onClick={() => { props.onSetModels(channel.models.filter((_, i) => i !== index)) }}>×</button>
                      </div>
                    </li>
                  )
                }
                // Root bucket (no folder key in the alias): render inline with
                // no header and never collapse.
                if (group.folder === '') {
                  return (
                    <li key="__selected_root__" className={css.modelRootBucket}>
                      {group.items.map(item => renderItem(item))}
                    </li>
                  )
                }
                return (
                  <li key={groupKey} className={css.modelFolder}>
                    {comfyUi
                      ? (
                        <button
                          type="button"
                          className={css.modelFolderHeader}
                          aria-expanded={!collapsed}
                          onClick={() => { toggleFolder(groupKey) }}
                        >
                          <span aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
                          <span className={css.modelFolderName}>{group.folder}</span>
                          <span className={css.modelFolderCount}>{group.items.length}</span>
                        </button>
                      )
                      : <h5 className={css.label}>{t('channels.modelCatalogTitle')}</h5>}
                    {!collapsed
                      ? (
                        <ul className={css.modelFolderList}>
                          {group.items.map(item => renderItem(item))}
                        </ul>
                      )
                      : null}
                  </li>
                )
              })}
            </ul>
          )}

        <div className={css.editorTools}>
          <div className={css.manualModelRow}>
            <input className={css.input} value={manualId} placeholder={t('channels.manualAddPlaceholder')} disabled={!props.writable} onChange={event => { setManualId(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManual() } }} />
            <button type="button" className={css.addModel} disabled={!props.writable || manualId.trim() === ''} onClick={addManual}>{t('channels.addModelConfirm')}</button>
          </div>
          {props.otherChannels.length > 0 ? (
            <div className={css.manualModelRow}>
              <select className={css.modelChoices} value={copyFrom} disabled={!props.writable} onChange={event => { setCopyFrom(event.target.value) }} aria-label={t('channels.copyFrom')}>
                <option value="">{t('channels.copyFrom')}</option>
                {props.otherChannels.map(other => (
                  <option key={other.id} value={other.id}>{other.name || t('channels.untitled')}</option>
                ))}
              </select>
              <button type="button" className={css.addModel} disabled={!props.writable || copyFrom === ''} onClick={copyFromChannel}>{t('channels.copyApply')}</button>
            </div>
          ) : null}
        </div>

        <div className={css.editorDivider} />

        <div className={css.editorFooter}>
          {props.isDefault ? <span className={css.channelBadge} data-default>{t('channels.defaultLabel')}</span> : (
            <button type="button" className={css.inlineDisclosure} disabled={!props.writable} onClick={props.onSetDefault}>{t('channels.setDefault')}</button>
          )}
          <span className={css.spacer} />
          {removeOpen
            ? (
              <>
                <button type="button" className={css.channelDanger} disabled={!props.writable} onClick={props.onRemove}>{t('channels.confirm')}</button>
                <button type="button" className={css.channelAction} onClick={() => { setRemoveOpen(false) }}>{t('channels.cancel')}</button>
              </>
            )
            : (
              <button type="button" className={css.channelAction} data-danger onClick={() => { setRemoveOpen(true) }}>{t('channels.deleteThisChannel')}</button>
            )}
        </div>
      </div>
    </div>
  )
}

/** Props every field control needs regardless of its value type. */
interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/** A staged value field; `secret` renders a password control. */
function ValueField(props: FieldProps & {
  /** Render a password control. */
  secret?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
  /** Label of the dedicated clear control (secret fields). */
  clearLabel?: string
  /** Stage a clear of the stored secret. */
  onClear?: () => void
  /** Whether a stored secret exists (enables the clear control). */
  canClear?: boolean
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
        {props.secret === true && props.canClear === true
          ? (
            <button
              type="button"
              className={css.reset}
              disabled={props.disabled}
              onClick={props.onClear}
            >
              {props.clearLabel ?? props.resetLabel}
            </button>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type={props.secret === true ? 'password' : 'text'}
        autoComplete={props.secret === true ? 'off' : undefined}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** A staged boolean field: 继承 / 开 / 关. */
function BooleanField(props: FieldProps & {
  /** Copy for the inherit option. */
  inheritLabel: string
  /** Copy for the on option. */
  onLabel: string
  /** Copy for the off option. */
  offLabel: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <select
        id={props.id}
        className={css.select}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        <option value="">{props.inheritLabel}</option>
        <option value="true">{props.onLabel}</option>
        <option value="false">{props.offLabel}</option>
      </select>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

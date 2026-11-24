import { containerTypeOptions, fillingTypeOptions, type FillingType } from '../domain'
import { CreationSteps } from '../components/CreationSteps'
import { useBusinessDateTime } from '../applicationClock'
import { WaybillFilterFields } from '../components/WaybillFilterFields'
import { validateWaybillSelection } from '../waybillSelection'
import { Notification } from '../components/Notification'
import { VehicleCargoEditor } from '../components/VehicleCargoEditor'
import { RoutePicker } from '../components/RoutePicker'
import { OrderContainerTable } from '../components/OrderContainerTable'
import { receivingWaybillRows } from '../orderContainerRows'
import { WaybillCompositionTable } from '../components/WaybillCompositionTable'
import { StatusBadge } from '../components/StatusBadge'
import { UiInput, UiSelect } from '../components/FormControls'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { StockOwnerSelect } from '../components/StockOwnerSelect'
import { createOrder, getContracts, getRoutes, getReferenceOptions, getTerminalAreas, getTransportTypes } from '../api'
import { WaybillSelectionTable } from '../components/WaybillSelectionTable'
import type {
  GroupedWaybillFilter,
  OrderConfig,
  ReferenceOption,
  TerminalAreaOption,
  TransportType,
  TransportTypeOption,
} from '../domain'

import {
  buildPayload,
  filterTransportTypes,
  findContainerArea,
  initialOrderFormState,
  setContainerCargoItems,
  setContainerEmpty,
  type SelectedContainer,
  type OrderFormState,
  validateStep,
} from '../orderForm'
import type { RouteSummary, RouteType } from '../routes'


const vehicleSteps = ['Основное', 'КТК', 'Груз']

const receivingRailwaySteps = ['Основное', 'Накладные ЭТРАН', 'Вагоны', 'КТК', 'Груз']
const shippingRailwaySteps = ['Основное', 'Вагоны', 'КТК', 'Груз']

export function CreateOrderPage({ config }: { config: OrderConfig }) {
  const [containerOwners, setContainerOwners] = useState<Record<string, string>>({})
  const [waybillFilter, setWaybillFilter] = useState<GroupedWaybillFilter>({})
  const [ownerActionTarget, setOwnerActionTarget] = useState<HTMLDivElement | null>(null)
  const [step, setStep] = useState(1)
  const [formDraft, setForm] = useState<OrderFormState>(() => ({ ...initialOrderFormState }))
  const [plannedAt, setPlannedAt] = useBusinessDateTime()
  const form = { ...formDraft, [config.kind === 'receiving' ? 'arrivalAt' : 'departureAt']: plannedAt }
  const [routes, setRoutes] = useState<RouteSummary[]>([])
  const [routeLoadError, setRouteLoadError] = useState('')
  const [routesLoading,setRoutesLoading]=useState(true)
  const [contracts, setContracts] = useState<import('../domain').ContractOption[]>([])
  const [clients, setClients] = useState<ReferenceOption[]>([])
  const [containers, setContainers] = useState<ReferenceOption[]>([])
  const [cargoOptions, setCargoOptions] = useState<ReferenceOption[]>([])
  const [railwayCarriages, setRailwayCarriages] = useState<ReferenceOption[]>([])
  const [terminalArea, setTerminalArea] = useState<TerminalAreaOption | null>(null)
  const [transportTypes, setTransportTypes] = useState<TransportTypeOption[]>([])
  const [containerRows, setContainerRows] = useState([''])
  const [loadingReferences, setLoadingReferences] = useState(true)
  const [errors, setErrors] = useState<string[]>([])
  const [requestError, setRequestError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submitLock = useRef(false)
  const isUnnumberedVehicleShipping = form.fillingType === 'NONE_CONTAINER'
  const nextRailwayKey = useRef(1)

const navigate = useNavigate()

  useEffect(() => {
    Promise.all([
      getReferenceOptions('clients'),
      getReferenceOptions('containers'),
      getReferenceOptions('etsng-codes'),
      getReferenceOptions('railway-carriages'),
      getTerminalAreas(),
      getTransportTypes(),
      getContracts(),
    ])
      .then(([clientOptions, containerOptions, etsngOptions, carriageOptions, terminalAreas, transportOptions, contractOptions]) => {
        const containerArea = findContainerArea(terminalAreas)
        setContracts(contractOptions)
        setClients(clientOptions)
        setContainers(containerOptions)
        setCargoOptions(etsngOptions)
        setRailwayCarriages(carriageOptions)
        setTerminalArea(containerArea)
        setTransportTypes(filterTransportTypes(transportOptions))
        if (containerArea) {
          setForm((state) => ({
            ...state,
            terminalAreaId: containerArea.id,
          }))
        } else {
          setRequestError('Контейнерная площадка отсутствует в справочнике')
        }
      })
      .catch((error: unknown) => setRequestError(
        error instanceof Error ? error.message : 'Не удалось загрузить справочники',
      ))
      .finally(() => setLoadingReferences(false))
  }, [])

  useEffect(() => {
    getRoutes().then(setRoutes).catch(() => setRouteLoadError('Не удалось загрузить рейсы')).finally(()=>setRoutesLoading(false))
  }, [])

  const loadedContainers = form.containers.filter(container => !container.empty)
  const loadedRailwayContainers = form.railwayCarriages.flatMap((carriage, carriageIndex) =>
      carriage.containers
        .filter((container) => !container.empty)
        .map((container) => ({ carriage, carriageIndex, container })),
  )

  const isRailwayReceiving = config.kind === 'receiving' && form.transportType === 'RAILWAY'
  const isRailwayShipping = config.kind === 'shipping' && form.transportType === 'RAILWAY'

  const isRailway = isRailwayReceiving || isRailwayShipping
  const steps = isRailwayReceiving
    ? receivingRailwaySteps
    : isRailwayShipping
      ? shippingRailwaySteps
      : isUnnumberedVehicleShipping ? vehicleSteps.slice(0,2) : vehicleSteps
  const visibleSteps = [steps[0], 'Рейс', ...steps.slice(1)]
  const lastStep = visibleSteps.length
  const contentStep = step === 2 ? 0 : step > 2 ? step - 1 : step
  const availableTransportTypes = transportTypes
  const generalErrors = errors

  const selectedContract = contracts.find(item => item.id === form.contractId)

  const mainStepInvalid = loadingReferences
    || (isRailwayReceiving && validateWaybillSelection(waybillFilter).length > 0)
    || !form.clientId
    || !form.contractId
    || !form.terminalAreaId
    || !form.transportType
    || (config.kind === 'receiving' && !form.defaultContainerOwnerId)

  const goNext = () => {
    const validationErrors = [
      ...validateStep(form, contentStep, config.kind),
      ...(isRailwayReceiving && contentStep === 1 ? validateWaybillSelection(waybillFilter) : []),
    ]
    setErrors(validationErrors)
    if (validationErrors.length === 0) setStep((current) => Math.min(lastStep, current + 1))
  }

  const goBack = () => {
    setErrors([])
    setStep((current) => Math.max(1, current - 1))
  }

  const openStep = (targetStep: number) => {
    if (targetStep >= step) return
    setErrors([])
    setStep(targetStep)
  }

  const setContainerAt = (rowIndex: number, containerId: string) => {
    const nextRows = [...containerRows]
    nextRows[rowIndex] = containerId
    setContainerRows(nextRows)

    setForm((state) => {
      const currentById = new Map(state.containers.map((container) => [container.id, container]))
      const nextContainers = nextRows
        .filter(Boolean)
        .map((id) => {
          const current = currentById.get(id)
          if (current) return current
          const option = containers.find((container) => container.id === id)
          return option
            ? { id: option.id, name: option.name, empty: false, etsngCodeId: '', weight: '' }
            : null
        })
        .filter((container) => container !== null)

      return { ...state, containers: nextContainers }
    })
  }

  const submit = async () => {
    if (submitLock.current) return
    const validationErrors = [
      ...validateStep(form, lastStep - 1, config.kind),
    ]
    setErrors(validationErrors)
    if (validationErrors.length > 0) return

    submitLock.current = true
    setSubmitting(true)
    setRequestError('')
    try {
      const created = await createOrder(config.apiPath, { ...buildPayload(form, config.kind), ...(isRailwayReceiving ? {
        containerOwners: receivingWaybillRows(form.waybills, form.defaultContainerOwnerId, clients, containerOwners).filter(row => containerOwners[row.containerId]).map(row => ({ containerId: row.containerId, ownerClientId: containerOwners[row.containerId] }))
      } : {}) })
      navigate(config.listPath, { state: { createdCode: created.code } })
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Не удалось создать заявку')
      submitLock.current = false
      setSubmitting(false)
    }
  }

  const changeTransport = (nextTransport: TransportType | '') => {
    if (form.transportType === 'VEHICLE' && nextTransport === 'RAILWAY' && form.containers.length > 0) {
      if (!window.confirm('При переходе на ЖД выбранные КТК будут очищены. Продолжить?')) return
    }
    if (
      form.transportType === 'RAILWAY'
      && nextTransport === 'VEHICLE'
      && (form.waybills.length > 0
        || form.railwayCarriages.length > 0
        || form.containers.length > 0
        || form.containerQuantities.length > 0)
    ) {
      if (!window.confirm('При переходе на Авто железнодорожный состав будет очищен. Продолжить?')) return
    }
    setErrors([])
    setContainerRows([''])
    setForm((state) => ({
      ...state,
      transportType: nextTransport,
      defaultContainerOwnerId: state.defaultContainerOwnerId,
      routeId: '',
      containers: [],
      waybills: nextTransport === 'VEHICLE' ? [] : state.waybills,
      railwayCarriages: nextTransport === 'VEHICLE' ? [] : state.railwayCarriages,
      fillingType: 'ALL',
      containerQuantities: [],
    }))
  }

const changeFillingType = (fillingType: FillingType) => {
    const hasComposition = form.railwayCarriages.length > 0
      || form.containers.length > 0
      || form.containerQuantities.length > 0
    if (hasComposition && fillingType !== form.fillingType) {
      if (!window.confirm('При изменении наличия данных текущий состав нужно очистить. Очистить состав и продолжить?')) return
    }
    setContainerRows([''])
    setErrors([])
    setForm((state) => ({
      ...state,
      fillingType,
      railwayCarriages: [],
      containers: [],
      containerQuantities: fillingType === 'NONE_CONTAINER' ? [{ key: 1, quantity: '1', type: '', empty: true, items: [] }] : [],
    }))
  }

  const updateRailwayCarriage = (
    key: number,
    update: (carriage: typeof form.railwayCarriages[number]) => typeof form.railwayCarriages[number],
  ) => {
    setForm((state) => ({
      ...state,
      railwayCarriages: state.railwayCarriages.map((carriage) => carriage.key === key ? update(carriage) : carriage),
    }))
  }


  const addRailwayContainer = (key: number) => {
    const container: SelectedContainer = { id: '', name: '', empty: false, etsngCodeId: '', weight: '' }
    updateRailwayCarriage(key, (carriage) => ({ ...carriage, containers: [...carriage.containers, container] }))
  }

  const updateRailwayContainer = (carriageKey: number, index: number, change: Partial<SelectedContainer>) => {
    updateRailwayCarriage(carriageKey, (carriage) => ({
      ...carriage,
      containers: carriage.containers.map((container, containerIndex) =>
        containerIndex === index ? { ...container, ...change } : container,
      ),
    }))
  }

  return (
    <section className="form-page">
      <div className="page-header form-page-header">
        <h1>{config.createTitle}</h1>
        <div className="header-actions">
          {step > 1 && (<button className="secondary-button" onClick={goBack} disabled={submitting}>← Назад</button>)}
          <Link className="close-button" to={config.listPath} aria-label="Закрыть форму" title="Закрыть">×</Link>
          {step < lastStep ? (
            <button
              className="primary-button"
              onClick={goNext}
              disabled={step === 1 && mainStepInvalid}
            >
              Далее <span>→</span>
            </button>
          ) : (
            <button className="primary-button" onClick={submit} disabled={submitting}>
              {submitting ? 'Создаём…' : 'Создать заявку'}
            </button>
          )}
        </div>
      </div>

      <div className="form-workspace">
        <div className="order-tabs-toolbar">
        <CreationSteps labels={visibleSteps} current={step} onSelect={openStep} aria-label="Этапы создания заявки" />

        <div className="order-tabs-actions" ref={setOwnerActionTarget} />
        </div>

        {requestError && <Notification kind="error">{requestError}</Notification>}
        {generalErrors.length > 0 && (
          <Notification kind="error" title="Проверьте данные" onDismiss={() => setErrors([])}>
            {generalErrors.map((error) => <span key={error}>{error}</span>)}
          </Notification>
        )}

{step === 1 && (
          <div className="form-section ui-form-section">
            <div className="form-section-heading"><h2>Основная информация</h2></div>
            <div className="form-fields-grid">
              <div className="form-fields-column">
                <label className="field horizontal-field"><span>Номер заявки:</span><UiInput value="" placeholder="Присваивается автоматически" disabled /></label>
                <label className="field horizontal-field">
                  <span>Клиент:<b>*</b></span><span className="field-control">
                    <UiSelect required value={form.clientId} onChange={event => setForm(current => ({ ...current, clientId: event.target.value, contractId: '' }))} disabled={loadingReferences}>
                      <option value="" hidden disabled />{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
                    </UiSelect>
                    {!loadingReferences && clients.length === 0 && <small>В справочнике пока нет клиентов.</small>}
                  </span>
                </label>
                <label className="field horizontal-field">
                  <span>Договор:<b>*</b></span><span className="field-control">
                    <UiSelect required value={form.contractId} disabled={loadingReferences || !form.clientId} onChange={event => setForm({ ...form, contractId: event.target.value })}>
                      <option value="" hidden disabled />{contracts.filter(item => item.clientId === form.clientId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </UiSelect>
                    {form.clientId && !loadingReferences && !contracts.some(item => item.clientId === form.clientId) && <small>У клиента нет договоров.</small>}
                  </span>
                </label>
              </div>
              <div className="form-fields-column">
                <div className="field horizontal-field"><span>Статус:</span><div className="ui-readonly-value"><StatusBadge status="DRAFT" /></div></div>
                {<div className="field horizontal-field"><span>Вид договора:</span><div className="ui-readonly-value">{selectedContract?.contractType || 'Выберите договор'}</div></div>}

              </div>
            </div>
            {isRailwayReceiving && <label className="field horizontal-field"><span>Собственник вагонов по умолчанию:<b>*</b></span><UiSelect required value={form.defaultRailwayCarriageOwnerId || form.clientId} onChange={e => setForm(state => ({ ...state, defaultRailwayCarriageOwnerId: e.target.value }))}><option value="">Выберите собственника</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</UiSelect></label>}
            {isRailwayReceiving && <WaybillFilterFields value={waybillFilter} disabled={submitting} onChange={value => {
              setWaybillFilter(value)
              setForm(state => ({ ...state, waybills: [] }))
              setContainerOwners({})
              setErrors([])
            }} />}
              <div className="form-section-heading ui-section-divider"><h2>Параметры заявки</h2></div>
              <div className="form-fields-grid">
                <div className="form-fields-column">
                  <label className="field horizontal-field"><span>Площадка:<b>*</b></span><span className="field-control"><UiInput value={loadingReferences ? 'Загрузка…' : terminalArea?.name ?? ''} placeholder="Контейнерная площадка недоступна" readOnly aria-readonly="true" />{!loadingReferences && !terminalArea && <small>Контейнерная площадка не найдена.</small>}</span></label>
                  <label className="field horizontal-field"><span>Вид транспорта:<b>*</b></span><span className="field-control"><UiSelect required value={form.transportType} onChange={event => changeTransport(event.target.value as TransportType | '')} disabled={loadingReferences}><option value="" hidden disabled />{availableTransportTypes.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}</UiSelect>{!loadingReferences && transportTypes.length === 0 && <small>Типы транспорта недоступны.</small>}</span></label>
                  {config.kind === 'shipping' && form.transportType && <label className="field horizontal-field"><span>Наличие номеров:</span><UiSelect disabled={form.transportType === 'RAILWAY'} value={form.fillingType} onChange={e => changeFillingType(e.target.value as FillingType)}>
                    {fillingTypeOptions.filter(option => form.transportType === 'VEHICLE' || option.value === 'ALL').map(option => <option key={option.value} value={option.value}>{form.transportType === 'VEHICLE' && option.value === 'ALL' ? 'Заданы номера КТК' : option.name}</option>)}
                  </UiSelect></label>}
                  <label className="field horizontal-field"><span>Номер транспортной накладной:</span><UiInput maxLength={255} value={form.transportWaybillNumber} onChange={event => setForm(state => ({ ...state, transportWaybillNumber: event.target.value }))} /></label>
                </div>
                {<div className="form-fields-column">
                  <div className="field horizontal-field"><span>Валюта стоимости груза:</span><div className="ui-readonly-value">RUB</div></div>
                  <label className="field horizontal-field"><span>{config.kind === 'receiving' ? 'Дата и время поступления:' : 'Дата и время вывоза:'}</span><UiInput type="datetime-local" step={60} value={config.kind === 'receiving' ? form.arrivalAt : form.departureAt} onChange={event => setPlannedAt(event.target.value)} /></label>
                {config.kind === 'receiving' && <label className="field horizontal-field"><span>Собственник КТК по умолчанию:<b>*</b></span><UiSelect aria-label="Собственник КТК по умолчанию" required value={form.defaultContainerOwnerId || ''} disabled={loadingReferences || !form.clientId} onChange={event => setForm(current => ({ ...current, defaultContainerOwnerId: event.target.value }))}><option value="" hidden disabled />{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</UiSelect></label>}
                </div>}
              </div>
              {<>
                <div className="form-section-heading ui-section-divider"><h2>Контактная информация</h2></div>
                <div className="form-fields-grid"><div className="form-fields-column">
                  <label className="field horizontal-field"><span>{config.kind === 'receiving' ? 'Грузоотправитель:' : 'Грузополучатель:'}</span><UiSelect aria-label={config.kind === 'receiving' ? 'Грузоотправитель' : 'Грузополучатель'} value={config.kind === 'receiving' ? form.consignor : form.consignee} disabled={loadingReferences} onChange={event => setForm(state => ({ ...state, [config.kind === 'receiving' ? 'consignor' : 'consignee']: event.target.value }))}><option value="" hidden disabled />{clients.map(client => <option key={client.id} value={client.name}>{client.name}</option>)}</UiSelect></label>
<label className="field horizontal-field"><span>Уполномоченный представитель:</span><UiInput  maxLength={255} value={form.authorizedRepresentative} onChange={event => setForm(state => ({ ...state, authorizedRepresentative: event.target.value }))} /></label>
                </div><div className="form-fields-column"><label className="field horizontal-field"><span>Телефон:</span><UiInput type="tel" maxLength={50} value={form.phone} onChange={event => setForm(state => ({ ...state, phone: event.target.value }))} /></label>
<label className="field horizontal-field"><span>Email:</span><UiInput type="email" maxLength={254} value={form.email} onChange={event => setForm(state => ({ ...state, email: event.target.value }))} /></label></div></div>
                <div className="form-section-heading ui-section-divider"><h2>Дополнительная информация</h2></div>
                <label className="field horizontal-field"><span>Комментарий:</span><textarea className="receiving-comment-input" maxLength={4000} rows={3} value={form.comment} onChange={event => setForm(state => ({ ...state, comment: event.target.value }))} /></label>
              </>}
          </div>
        )}

        {step === 2 && <div className="form-section"><RoutePicker routes={routes} routeType={config.kind.toUpperCase() as RouteType} transportType={form.transportType as TransportType} terminalAreaId={form.terminalAreaId}
          selectedId={form.routeId} onSelect={id=>setForm(state=>({...state,routeId:id}))} loading={routesLoading} error={routeLoadError}
          onCreated={route=>setRoutes(current=>[route,...current])}
          /></div>}

        {((contentStep === 2 && !isRailway && !isUnnumberedVehicleShipping)) && <div className="form-section"><OrderContainerTable
   rows={containerRows.map((id,index) => ({ ...(form.containers.find(c => c.id===id) ?? { empty:false }), key:String(index), containerId:id, name:containers.find(c => c.id===id)?.name ?? '' }))}
   options={containers} ownerReadOnly={config.kind === 'shipping'} defaultOwnerId={form.defaultContainerOwnerId}
   onSelect={(key,id) => setContainerAt(Number(key),id)} onAdd={() => setContainerRows(rows => [...rows,''])}
   onRemove={key => { setContainerAt(Number(key),''); setContainerRows(rows => rows.filter((_,index) => index!==Number(key))) }}
   allowEmptyEdit onChange={(key,change) => { const id=containerRows[Number(key)]; setForm(state => {
     const next=change.empty===undefined ? state : setContainerEmpty(state,id,change.empty)
     return { ...next, containers:next.containers.map(c => c.id===id ? { ...c,...change } : c) }
   }) }} /></div>}

{contentStep === 2 && isUnnumberedVehicleShipping && (
          <div className="form-section unnumbered-vehicle-section">
            <div className="unnumbered-vehicle-fields">
              <label className="field horizontal-field">
                <span>Количество КТК <b>*</b></span>
                <span className="field-control">
                  <UiInput
                    type="number" readOnly
                    min="1" max="1"
                    step="1"
                    value={form.containerQuantities[0]?.quantity ?? ''}
                    placeholder="Введите количество"


                    onChange={(event) => setForm((state) => ({
                      ...state,
                      containerQuantities: state.containerQuantities.map((row, index) =>
                        index === 0 ? { ...row, quantity: event.target.value } : row,
                      ),
                    }))}
                  />
                </span>
              </label>
              <label className="field horizontal-field">
                <span>Типоразмер КТК <b>*</b></span>
                <span className="field-control">
                  <UiSelect
                    value={form.containerQuantities[0]?.type ?? ''}
                    onChange={(event) => setForm((state) => ({
                      ...state,
                      containerQuantities: state.containerQuantities.map((row, index) =>
                        index === 0 ? { ...row, type: event.target.value as typeof row.type } : row,
                      ),
                    }))}
                  >
                    <option value="">Выберите типоразмер</option>
                    {containerTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.name}</option>)}
                  </UiSelect>
                </span>
              </label>
              <label className="field horizontal-field">
                <span>Собственник КТК <b>*</b></span><StockOwnerSelect type={form.containerQuantities[0]?.type} value={form.containerQuantities[0]?.ownerClientId} onChange={ownerClientId => setForm(state => ({ ...state, containerQuantities: state.containerQuantities.map(row => ({ ...row, ownerClientId })) }))} />
              </label><label className="field horizontal-field"><span>Состояние КТК <b>*</b></span>
                <span className="field-control"><UiInput value="Порожний" readOnly aria-readonly="true" /></span>
              </label>
            </div>
          </div>
        )}

        {contentStep === 2 && isRailwayReceiving && <WaybillSelectionTable filter={waybillFilter} selected={form.waybills} disabled={submitting}
          onChange={waybills => { setForm(state => ({ ...state, waybills })); const ids = new Set(receivingWaybillRows(waybills, form.defaultContainerOwnerId, clients).map(row => row.containerId)); setContainerOwners(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)))); setErrors([]) }} />}

        {isRailwayReceiving && contentStep === 4 && <div className="form-section"><OrderContainerTable bulkOwnerActionTarget={ownerActionTarget} showPhysicalAttributes attributesReadOnly ownerOptions={clients} bulkOwnerDisabled={submitting} onBulkOwnerChange={(ids, owner) => setContainerOwners(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, owner.id])) }))} onChange={!submitting ? (id, change) => { if (change.ownerClientId) setContainerOwners(current => ({ ...current, [id]: change.ownerClientId! })) } : undefined} rows={receivingWaybillRows(form.waybills,form.defaultContainerOwnerId,clients,containerOwners)} groups={form.waybills.map(bill => ({ key:bill.id,label:"Накладная № "+bill.number,rows:[],children:(bill.railwayCarriages ?? []).map(wagon => ({ key:bill.id+"-"+wagon.id,label:"Вагон № "+wagon.number,rows:receivingWaybillRows([{...bill,railwayCarriages:[wagon]}],form.defaultContainerOwnerId,clients,containerOwners) })) }))} /></div>}
        {isRailwayReceiving && (contentStep === 3 || contentStep === 5) && (
          <WaybillCompositionTable key={contentStep} waybills={form.waybills} tab={contentStep === 3 ? 'wagons' : 'cargo'} wagonAttributes />
        )}

        {contentStep === 2 && isRailwayShipping && (
          <div className="form-section shipping-railway-section">
            <div className="waybill-section-title">

              {(
                <button type="button" className="outline-action-button" onClick={() => setForm((state) => ({
                  ...state,
                  railwayCarriages: [...state.railwayCarriages, { key: nextRailwayKey.current++, railwayCarriageId: '', containers: [{ id: '', name: '', empty: false, etsngCodeId: '', weight: '' }] }],
                }))}>⊕ Добавить вагон</button>
              )}
            </div>

            {(form.railwayCarriages.length === 0 ? (
              <div className="inline-empty">Вагоны не добавлены</div>
            ) : (
              <div className="shipping-railway-list">
                {form.railwayCarriages.map((carriage, carriageIndex) => (
                  <article className="shipping-railway-card" key={carriage.key}>
                    <div className="shipping-railway-card-head">
                      <strong>Вагон {carriageIndex + 1}</strong>
                      <label className="field shipping-railway-carriage-select">
                        <span className="sr-only">Номер вагона {carriageIndex + 1}</span>
                        <UiSelect value={carriage.railwayCarriageId} onChange={(event) => updateRailwayCarriage(carriage.key, (item) => ({ ...item, railwayCarriageId: event.target.value }))}>
                          <option value="" hidden disabled />
                          {railwayCarriages.map((option) => <option key={option.id} value={option.id} disabled={form.railwayCarriages.some((item) => item.key !== carriage.key && item.railwayCarriageId === option.id)}>{option.name}</option>)}
                        </UiSelect>
                      </label>
                      <button type="button" className="row-clear-button" aria-label={`Удалить вагон ${carriageIndex + 1}`} title="Удалить вагон" onClick={() => {
                        if (carriage.containers.length > 0 && !window.confirm('В вагоне есть КТК. Удалить вагон вместе с ними?')) return
                        setForm((state) => ({ ...state, railwayCarriages: state.railwayCarriages.filter((item) => item.key !== carriage.key) }))
                      }}>×</button>
                    </div>
                  </article>
                ))}
              </div>
            ))}


          </div>
        )}

        {contentStep === 3 && isRailwayShipping && form.fillingType === 'ALL' && (
          <div className="form-section shipping-railway-section">
            <div className="waybill-section-title">


            </div>

            {form.fillingType === 'ALL' && (form.railwayCarriages.length === 0 ? <div className="inline-empty">Вагоны не добавлены</div> : (
              <div className="shipping-railway-list">
                {form.railwayCarriages.map((carriage, carriageIndex) => (
                  <article className="shipping-railway-card" key={carriage.key}>
                    <div className="shipping-railway-card-head"><strong>Вагон {carriageIndex + 1}</strong><span className="railway-carriage-code">{railwayCarriages.find((option) => option.id === carriage.railwayCarriageId)?.name ?? 'Номер не выбран'}</span></div>
                    <OrderContainerTable
   rows={carriage.containers.map((c,index) => ({ ...c, key:String(index), containerId:c.id }))}
   options={containers} selectedIds={form.railwayCarriages.flatMap(w => w.containers.map(c => c.id))} ownerReadOnly allowEmptyEdit
   onSelect={(key,id) => { const option=containers.find(c=>c.id===id); updateRailwayContainer(carriage.key,Number(key),{ id,name:option?.name ?? '',empty:false,etsngCodeId:'',weight:'',sealNumbers:null,sealTypeId:null,hazardClassId:null }) }}
   onChange={(key,change) => { const c=carriage.containers[Number(key)]; updateRailwayContainer(carriage.key,Number(key),{ ...change,...(change.empty ? { etsngCodeId:'',weight:'' } : { etsngCodeId:c.etsngCodeId,weight:c.weight }) }) }}
   onRemove={key => updateRailwayCarriage(carriage.key,item=>({ ...item,containers:item.containers.filter((_,index)=>index!==Number(key)) }))} />
                    <button type="button" className="railway-add-container-button" onClick={() => addRailwayContainer(carriage.key)}>⊕ Добавить КТК</button>
                  </article>
                ))}
              </div>
            ))}

</div>
        )}

{contentStep === 4 && isRailwayShipping && form.fillingType === 'ALL' && (
          <div className="form-section shipping-railway-section">

            {form.fillingType === 'ALL' && (loadedRailwayContainers.length === 0 ? (
              <div className="all-empty-message"><span>✓</span><div><strong>Все выбранные КТК порожние</strong><p>Данные о грузе заполнять не требуется.</p></div></div>
            ) : <div className="cargo-table">
              <div className="cargo-table-header railway-cargo-grid"><span>Вагон</span><span>КТК</span><span>Груз</span><span>Масса брутто, кг</span></div>
              {loadedRailwayContainers.map(({ carriage, carriageIndex, container }) => {
                const containerIndex = carriage.containers.indexOf(container)
                return <div className="cargo-row railway-cargo-grid" key={`${carriage.key}-${container.id}`}>
                  <strong>{railwayCarriages.find((option) => option.id === carriage.railwayCarriageId)?.name ?? `Вагон ${carriageIndex + 1}`}</strong>
                  <strong>{container.name}</strong>
                  <label className="field"><UiSelect value={container.etsngCodeId} onChange={(event) => updateRailwayContainer(carriage.key, containerIndex, { etsngCodeId: event.target.value })}><option value="" hidden disabled />{cargoOptions.map((cargo) => <option key={cargo.id} value={cargo.id}>{cargo.name}</option>)}</UiSelect></label>
                  <label className="field weight-field"><UiInput type="text" inputMode="decimal" placeholder="0.000" value={container.weight} onChange={(event) => updateRailwayContainer(carriage.key, containerIndex, { weight: event.target.value })} /></label>
                </div>
              })}
            </div>)}

</div>
        )}

        {((contentStep === 3 && !isRailway && !isUnnumberedVehicleShipping)) && (
          <div className="form-section">

            {loadedContainers.length === 0 ? (
              <div className="all-empty-message">
                <span>✓</span>
                <div><strong>Все выбранные КТК порожние</strong><p>Данные о грузе заполнять не требуется.</p></div>
              </div>
            ) : (
              <VehicleCargoEditor containers={loadedContainers} cargoOptions={cargoOptions} disabled={submitting}
                onChange={(id, items) => setForm(state => setContainerCargoItems(state, id, items))} />
            )}
          </div>
        )}


      </div>
    </section>
  )
}

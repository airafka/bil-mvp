type Props = {
  labels: readonly string[]
  current: number
  onSelect: (step: number) => void
  'aria-label': string
}

export function CreationSteps({ labels, current, onSelect, 'aria-label': ariaLabel }: Props) {
  return <div className="stepper" aria-label={ariaLabel}>
    {labels.map((label, index) => {
      const number = index + 1
      const stateClass = number === current ? 'current' : number < current ? 'complete' : ''
      return <button type="button" className={`step ${stateClass}`} key={label}
        onClick={() => onSelect(number)} disabled={number > current}>{label}</button>
    })}
  </div>
}

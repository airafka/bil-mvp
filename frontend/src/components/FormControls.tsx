import { type ComponentPropsWithRef } from 'react'

// Native semantics keep keyboard, form and validation behavior; select-controls.css styles every picker.
// Visual states and dimensions follow @alabuga/uikit 17.3.1 InputText / Select.
export function UiInput({ className = '', type = 'text', ...props }: ComponentPropsWithRef<'input'>) {
  const choice = type === 'checkbox' || type === 'radio'
  return <input {...props} type={type} className={`${choice ? 'ui-choice' : 'ui-control'} ${className}`} />
}
export function UiSelect({ className = '', value, onKeyDown, ...props }: ComponentPropsWithRef<'select'>) {
  return <select {...props} value={value} onKeyDown={event => {
    if (event.key === 'Escape' && event.currentTarget.matches(':open')) event.stopPropagation()
    onKeyDown?.(event)
  }} data-placeholder={value === '' || value == null} className={`ui-control ui-select ${className}`} />
}
export function UiTextarea({ className = '', ...props }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...props} className={`ui-control ${className}`} />
}

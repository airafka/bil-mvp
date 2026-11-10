import { describe, it, expect } from 'vitest'
import { transfer, wagonIssue, type PlacementContainer } from './waybillPlacement'
const a: PlacementContainer = { rowId:'a',containerId:'c1',number:'C1',type:'STANDARD_40',grossWeight:23000,waybillId:'bill1',waybillNumber:'101',wagonId:'w1',selected:true }
const b: PlacementContainer = { ...a,rowId:'b',containerId:'c2',number:'C2',waybillId:'bill2',waybillNumber:'102',wagonId:'w2' }
describe('railway placement',()=>{
 it('moves a container without moving its document identity',()=>{expect(transfer({},[a,b],'a','w2')).toEqual({a:'w2'});expect(a.waybillNumber).toBe('101')})
 it('swaps occupied positions using current draft positions',()=>expect(transfer({a:'w3'},[a,b],'a','w2','b')).toEqual({a:'w2',b:'w3'}))
 it('cannot move or swap an unselected document',()=>{expect(transfer({},[{...a,selected:false},b],'a','w2')).toEqual({});expect(transfer({},[a,{...b,selected:false}],'a','w2','b')).toEqual({})})
 it('counts other documents already on the same wagon',()=>{expect(wagonIssue({id:'w',number:'123',feet:80,capacity:70000},[a,b,{...a,rowId:'c',selected:false}])).toContain('двух')})
 it('checks length and gross mass and accepts exact boundaries',()=>{expect(wagonIssue({id:'w',number:'123',feet:80,capacity:46000},[a,b])).toBeNull();expect(wagonIssue({id:'w',number:'123',feet:60,capacity:46000},[a,b])).toContain('длины');expect(wagonIssue({id:'w',number:'123',feet:80,capacity:45999},[a,b])).toContain('грузоподъёмность')})
})

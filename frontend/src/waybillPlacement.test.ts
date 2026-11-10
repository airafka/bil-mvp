import { describe, it, expect } from 'vitest'
import { transfer, wagonIssue, wagonTracks, type PlacementContainer } from './waybillPlacement'
const a: PlacementContainer = { rowId:'a',containerId:'c1',number:'C1',type:'STANDARD_40',grossWeight:23000,waybillId:'bill1',waybillNumber:'101',wagonId:'w1',selected:true }
const b: PlacementContainer = { ...a,rowId:'b',containerId:'c2',number:'C2',waybillId:'bill2',waybillNumber:'102',wagonId:'w2' }
describe('railway placement',()=>{
 it('reserves half of an 80ft platform for a single 40ft container',()=>expect(wagonTracks({id:'w',number:'1',feet:80,capacity:null},[a])).toEqual({freeFeet:40,columns:'minmax(0,40fr) minmax(0,40fr)'}))
 it('uses proportional tracks for mixed lengths and preserves the free quarter',()=>expect(wagonTracks({id:'w',number:'1',feet:80,capacity:null},[a,{...b,type:'STANDARD_20'}])).toEqual({freeFeet:20,columns:'minmax(0,40fr) minmax(0,20fr) minmax(0,20fr)'}))
 it('shows every container of an overloaded source without a negative free area',()=>{const tracks=wagonTracks({id:'w',number:'1',feet:80,capacity:null},Array.from({length:6},()=>({...a,type:'STANDARD_20'})));expect(tracks.freeFeet).toBe(0);expect(tracks.columns.split(' ')).toHaveLength(6)})
 it('moves a container without moving its document identity',()=>{expect(transfer({},[a,b],'a','w2')).toEqual({a:'w2'});expect(a.waybillNumber).toBe('101')})
 it('swaps occupied positions using current draft positions',()=>expect(transfer({a:'w3'},[a,b],'a','w2','b')).toEqual({a:'w2',b:'w3'}))
 it('cannot move or swap an unselected document',()=>{expect(transfer({},[{...a,selected:false},b],'a','w2')).toEqual({});expect(transfer({},[a,{...b,selected:false}],'a','w2','b')).toEqual({})})
 it('counts length of unselected containers',()=>{expect(wagonIssue({id:'w',number:'123',feet:80,capacity:70000},[a,b,{...a,rowId:'c',selected:false}])).toContain('длина')})
 it('allows four 20ft containers regardless of mass or lifting capacity',()=>{const rows=Array.from({length:4},(_,i)=>({...a,rowId:String(i),type:'STANDARD_20',grossWeight:99000}));expect(wagonIssue({id:'w',number:'123',feet:80,capacity:1},rows)).toBeNull();expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},rows)).toBeNull();expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},[...rows,rows[0]])).toContain('длина')})
 it('accepts mixed lengths and rejects lengths above platform capacity',()=>{const twenty={...a,type:'STANDARD_20'};expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},[a,twenty,twenty])).toBeNull();expect(wagonIssue({id:'w',number:'123',feet:60,capacity:null},[a,b])).toContain('длина')})
 it('rejects unknown platform or container length',()=>{expect(wagonIssue({id:'w',number:'123',feet:null,capacity:null},[a])).toContain('длина');expect(wagonIssue({id:'w',number:'123',feet:80,capacity:null},[{...a,type:'OTHER'}])).toContain('футовость')})
})
